import { diagnostic } from "../shared/diagnostics";
import { safeErrorCode } from "../shared/errors";
import { logEvent, withTelemetry } from "../shared/telemetry";
import { dispatchDue, type SchedulerEnv } from "./dispatch";

export async function executeScheduler(env: SchedulerEnv, time: Date) {
  const runId = crypto.randomUUID();
  const started = Date.now();
  return withTelemetry(env, "astro-shared-scheduler", { runId }, async () => {
    let result: Awaited<ReturnType<typeof dispatchDue>>;
    try {
      result = await dispatchDue(env, time);
      logEvent(result.status === "failed" ? "error" : "info", { event: "scheduler_finished",
        scheduledTime: time.toISOString(), durationMs: Date.now() - started, ...result });
    } catch (error) {
      logEvent("error", { event: "scheduler_failed", code: safeErrorCode(error), ...diagnostic(error), durationMs: Date.now() - started });
      throw new Error(`Falha no disparador; consulte o runId ${runId}`);
    }
    if (result.status === "failed") throw new Error(`Falha em tarefas do disparador; consulte o runId ${runId}`);
    return result;
  });
}
