import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/shared/worker";
import type { Env } from "../src/shared/types";

const context = {} as ExecutionContext;
const controller = { scheduledTime: Date.now(), cron: "0 11 * * *", noRetry() {} } as ScheduledController;

afterEach(() => vi.restoreAllMocks());

describe("entrada de cada Worker", () => {
  it("expõe apenas a identificação e a saúde do processo", async () => {
    const worker = createWorker("expiring-compliance");
    const response = await worker.fetch!(new Request("https://example.com/health"), {} as Env, context);
    expect(await response.json()).toEqual({
      service: "astro-notification-service", rule: "expiring-compliance", status: "ok",
    });
    const forbidden = await worker.fetch!(new Request("https://example.com/run", { method: "POST" }), {}, context);
    expect(forbidden.status).toBe(404);
  });

  it("não consulta bancos quando desabilitado", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createWorker("expiring-compliance").scheduled!(controller, {}, context);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      event: "execution_finished", status: "skipped", reason: "disabled",
    });
  });
});
