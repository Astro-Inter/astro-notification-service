import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";
import { workers } from "../../scripts/worker-list.mjs";

const configs = workers.map(rule => {
  const config = JSON.parse(readFileSync(`workers/${rule}/wrangler.jsonc`, "utf8"));
  delete config.hyperdrive;
  delete config.account_id;
  delete config.$schema;
  config.main = resolve(`src/workers/${rule}.ts`);
  config.vars = { ...config.vars, ENABLED: "false", DRY_RUN: "true" };
  return { config, secrets: { DATABASE_URL: "", MONGODB_URI: "", MONGODB_DATABASE: "" } };
});
const scheduler = JSON.parse(readFileSync("workers/scheduler/wrangler.jsonc", "utf8"));
const control = JSON.parse(readFileSync("workers/delivery-control/wrangler.jsonc", "utf8"));
delete control.account_id;
delete control.$schema;
control.main = resolve("src/workers/delivery-control.ts");
configs.push({ config: control });
const push = JSON.parse(readFileSync("workers/pending-events-push/wrangler.jsonc", "utf8"));
delete push.account_id; delete push.$schema; delete push.hyperdrive;
push.main = resolve("src/workers/pending-events-push.ts");
push.vars = { ...push.vars, ENABLED: "false", DRY_RUN: "true" };
configs.push({ config: push, secrets: { FIREBASE_PROJECT_ID: "", FIREBASE_CREDENTIALS_BASE64: "" } });
const chat = JSON.parse(readFileSync("workers/chat-message-push/wrangler.jsonc", "utf8"));
delete chat.$schema;
chat.main = resolve("src/workers/chat-message-push.ts");
chat.vars = { ENABLED: "false" };
configs.push({ config: chat, secrets: { CHAT_PUSH_SECRET: "runtime-test-".repeat(4) } });
configs.push({ config: { name: "chat-fixture", main: resolve("tests/runtime/chat-fixture.ts"),
  compatibility_date: "2026-10-18", compatibility_flags: ["nodejs_compat"], vars: { ENABLED: "true" },
  durable_objects: { bindings: [{ name: "FIXTURE", class_name: "ChatFixture" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["ChatFixture"] }] } });
configs.push({ config: { name: "control-fixture", main: resolve("tests/runtime/control-fixture.ts"),
  compatibility_date: "2026-10-18", compatibility_flags: ["nodejs_compat"],
  durable_objects: { bindings: [{ name: "FIXTURE", class_name: "ControlFixture" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["ControlFixture"] }] } });
delete scheduler.account_id;
delete scheduler.$schema;
scheduler.main = resolve("src/workers/scheduler.ts");
scheduler.services = scheduler.services.map(binding => binding.binding === "SUMMARY"
  ? { ...binding, service: "summary-fixture" } : binding);
configs.push({ config: scheduler });
configs.push({ config: { name: "summary-fixture", main: resolve("tests/runtime/summary-fixture.ts"),
  compatibility_date: "2026-10-16" } });
configs.push({ config: { name: "rpc-probe", main: resolve("tests/runtime/rpc-probe.ts"),
  compatibility_date: "2026-10-16", services: [...workers.map((rule, i) => ({
    binding: `JOB_${i}`, service: `astro-notification-${rule}`, entrypoint: "RuleJob",
  })), { binding: "SCHEDULER", service: "astro-shared-scheduler", entrypoint: "SchedulerControl" }] } });
const server = createTestHarness({ workers: configs });
before(async () => { await server.listen(); });
after(async () => { await server.close(); });

test("chat autentica a entrada e respeita o desligamento sem tocar no Firebase", async () => {
  const worker = server.getWorker("astro-notification-chat-message-push");
  const url = "https://example.com/internal/chat-messages";
  assert.equal((await worker.fetch(url, { method: "POST" })).status, 401);
  assert.equal((await worker.fetch(url, { method: "POST",
    headers: { Authorization: "Bearer " + "runtime-test-".repeat(4) } })).status, 503);
});

test("chat persiste recibo, recusa conflito, recupera alarme e remove prévia expirada", async () => {
  const fixture = server.getWorker("chat-fixture");
  const event = { version: 1, messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    conversationId: "11111111-2222-4333-8444-555555555555", senderId: "1", recipientId: "2",
    workspaceId: "10", recipientUid: "uid", senderName: "Gestor", preview: "Fixture", createdAt: new Date().toISOString() };
  const send = body => fixture.fetch("https://example.com/accept", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await send(event)).status, 202);
  assert.equal((await send(event)).status, 202);
  assert.equal((await send({ ...event, preview: "different" })).status, 409);
  await fixture.fetch("https://example.com/lost-alarm");
  assert.equal((await send(event)).status, 202);
  let state = await (await fixture.fetch("https://example.com/status")).json();
  assert.ok(state.alarm > 0);
  assert.equal(state.receipt.messageId, event.messageId);
  state = await (await fixture.fetch("https://example.com/expire")).json();
  assert.equal(state.state, undefined);
  assert.equal(state.receipt.messageId, event.messageId);
  assert.equal((await send(event)).status, 202);
});

for (const rule of workers) {
  test(`${rule}: inicia no workerd e não acessa bancos quando desabilitado`, async () => {
    const worker = server.getWorker(`astro-notification-${rule}`);
    const response = await worker.fetch("https://example.com/health");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).rule, rule);
    const result = await worker.scheduled({ cron: "0 11 * * *", scheduledTime: new Date() });
    assert.equal(result.outcome, "ok");
  });
  test(`${rule}: permite chamada interna sem expor execução por HTTP`, async () => {
    const binding = `JOB_${workers.indexOf(rule)}`;
    const probe = server.getWorker("rpc-probe");
    const status = await probe.fetch(`https://example.com/${binding}/status`);
    assert.deepEqual(await status.json(), { service: "astro-notification-service", rule,
      enabled: false, dryRun: true, scope: "all_workspaces" });
    const run = await probe.fetch(`https://example.com/${binding}/run`);
    assert.equal((await run.json()).reason, rule === "missing-compliance" ? "applicability_pending" : "disabled");
    const forbidden = await server.getWorker(`astro-notification-${rule}`).fetch("https://example.com/run", { method: "POST" });
    assert.equal(forbidden.status, 404);
  });
}

test("disparador preserva análises diárias e inclui o serviço push no gatilho horário", async () => {
  const probe = server.getWorker("rpc-probe");
  const response = await probe.fetch(`https://example.com/SCHEDULER/run?time=${Date.parse("2026-10-16T11:00:00Z")}`);
  const result = await response.json();
  assert.equal(result.status, "completed");
  assert.deepEqual(result.outcomes.map(outcome => outcome.job), ["SUMMARY", "CLASSES", "EXPIRING", "EXPIRED", "VALIDATIONS", "PUSH"]);
  assert.ok(result.outcomes.every(outcome => outcome.status === "fulfilled" && outcome.jobStatus === "skipped"));
  const hourly = await probe.fetch(`https://example.com/SCHEDULER/run?time=${Date.parse("2026-10-16T12:00:00Z")}`);
  assert.equal((await hourly.json()).outcomes.length, 3);
  const inspected = await probe.fetch("https://example.com/SCHEDULER/inspect");
  assert.equal((await inspected.json()).length, 6);
});

test("controle persistente coordena concorrência, reinício, exclusão e falha após gravar", async () => {
  const fixture = server.getWorker("control-fixture");
  assert.equal((await (await fixture.fetch("https://example.com/initialize")).json()).initialized, true);
  const intent = { deduplicationKey: "runtime-one", document: { usuario_id: 2, evento_id: 1,
    mensagem: "Fixture", titulo: "Fixture", data_criacao: "2026-10-18T12:00:00.000Z" } };
  const deliver = async body => {
    const response = await fixture.fetch("https://example.com/deliver", { method: "POST", body: JSON.stringify(body) });
    return { ...await response.json(), status: response.status };
  };
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => deliver(intent)));
  assert.equal(concurrent.filter(result => result.inserted).length, 1);
  assert.ok(concurrent.every(result => result.status === 200));
  const receipt = await fixture.fetch("https://example.com/receipt", { method: "POST", body: JSON.stringify(intent) });
  assert.deepEqual(await receipt.json(), { inserted: false, id: 1 });
  await fixture.fetch("https://example.com/clear");
  await fixture.fetch("https://example.com/restart");
  assert.equal((await deliver(intent)).inserted, false);
  assert.equal((await (await fixture.fetch("https://example.com/status")).json()).documents.length, 0);
  await fixture.fetch("https://example.com/fail");
  const retry = { ...intent, deduplicationKey: "runtime-retry" };
  assert.equal((await deliver(retry)).status, 500);
  const pending = await (await fixture.fetch("https://example.com/status")).json();
  assert.equal(pending.status.pending, 1); assert.equal(pending.documents[0]._id, 2);
  await fixture.fetch("https://example.com/restart");
  assert.equal((await deliver(retry)).inserted, false);
  const confirmed = await (await fixture.fetch("https://example.com/status")).json();
  assert.equal(confirmed.status.pending, 0); assert.equal(confirmed.status.confirmed, 2);
  assert.equal(confirmed.documents.length, 1); assert.equal(confirmed.documents[0]._id, 2);
});
