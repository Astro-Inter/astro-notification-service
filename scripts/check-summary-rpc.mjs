import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createTestHarness } from "wrangler";

const root = process.argv[2];
if (!root) throw new Error("Informe o caminho do repositório astro-session-summary-service");
const server = createTestHarness({ workers: [
  { config: { name: "summary-under-test", main: resolve(root, "src/entrypoint.ts"),
    compatibility_date: "2026-10-16", compatibility_flags: ["nodejs_compat"], vars: { ENABLED: "false" } } },
  { config: { name: "probe", main: resolve("tests/runtime/rpc-probe.ts"), compatibility_date: "2026-10-16",
    services: [{ binding: "SUMMARY", service: "summary-under-test", entrypoint: "ScheduledJob" }] } },
] });
try {
  await server.listen();
  const probe = server.getWorker("probe");
  const state = await probe.fetch("https://example.com/SUMMARY/status");
  assert.deepEqual(await state.json(), { service: "astro-session-summary-service", enabled: false });
  const response = await probe.fetch("https://example.com/SUMMARY/run");
  assert.equal((await response.json()).status, "skipped");
  const forbidden = await server.getWorker("summary-under-test").fetch("https://example.com/run", { method: "POST" });
  assert.equal(forbidden.status, 404);
  console.log("RPC do serviço de resumos validado no workerd; nenhuma sessão modificada.");
} finally { await server.close(); }
