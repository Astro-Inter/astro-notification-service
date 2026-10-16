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
  return { config, secrets: { DATABASE_URL: "", MONGODB_URI: "", MONGODB_DATABASE: "" } };
});
configs.push({ config: { name: "rpc-probe", main: resolve("tests/runtime/rpc-probe.ts"),
  compatibility_date: "2026-10-15", services: workers.map((rule, i) => ({
    binding: `JOB_${i}`, service: `astro-notification-${rule}`, entrypoint: "RuleJob",
  })) } });
const server = createTestHarness({ workers: configs });
before(async () => { await server.listen(); });
after(async () => { await server.close(); });

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
