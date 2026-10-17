import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeRule } from "../src/shared/execution";
import { runRule } from "../src/shared/runner";
import { executeScheduler } from "../src/scheduler/execution";
import { bindings, type SchedulerEnv } from "../src/scheduler/dispatch";

vi.mock("../src/shared/runner", () => ({ runRule: vi.fn() }));
const telemetry = { GRAFANA_OTLP_ENDPOINT: "https://collector.grafana.net/otlp", GRAFANA_OTLP_HEADERS: "Authorization=Basic%20fixture" };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("telemetria nas execuções reais", () => {
  it("exporta o erro sanitizado da regra antes de propagar a falha", async () => {
    vi.mocked(runRule).mockRejectedValueOnce({ code: "DATABASE_UNAVAILABLE", message: "URI e credenciais privadas" });
    await expect(executeRule("expired-compliance", telemetry)).rejects.toThrow("consulte o runId");
    const payload = JSON.parse(fetcher.mock.calls[0]![1].body);
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.severityText).toBe("ERROR");
    expect(JSON.parse(record.body.stringValue)).toMatchObject({ event: "execution_failed", rule: "expired-compliance", code: "DATABASE_UNAVAILABLE" });
    expect(JSON.stringify(payload)).not.toContain("privadas");
  });
  it("exporta a falha do disparador sem impedir a chamada dos outros destinos", async () => {
    const env = { ...telemetry, ENABLED: "true", ...Object.fromEntries(bindings.map(job => [job, {
      run: job === "CLASSES" ? vi.fn().mockRejectedValue({ code: "RULE_FAILURE" }) : vi.fn().mockResolvedValue({ status: "completed" }),
      status: vi.fn(),
    }])) } as unknown as SchedulerEnv;
    await expect(executeScheduler(env, new Date("2026-10-16T11:00:00Z"))).rejects.toThrow("Falha em tarefas");
    for (const job of bindings) expect(env[job].run).toHaveBeenCalledOnce();
    const record = JSON.parse(fetcher.mock.calls[0]![1].body).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.severityText).toBe("ERROR");
    expect(JSON.parse(record.body.stringValue)).toMatchObject({ event: "scheduler_finished", status: "failed",
      outcomes: expect.arrayContaining([{ job: "CLASSES", status: "failed", code: "RULE_FAILURE" }]) });
  });
});
