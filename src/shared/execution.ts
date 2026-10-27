import { diagnostic } from "./diagnostics";
import { safeErrorCode } from "./errors";
import { runRule } from "./runner";
import { logEvent, withTelemetry } from "./telemetry";
import type { Env, RuleId } from "./types";

export async function executeRule(rule: RuleId, env: Env) {
  const runId = crypto.randomUUID();
  const started = Date.now();
  return withTelemetry(env, `astro-notification-${rule}`, { rule, runId }, async () => {
    try {
      const result = await runRule(rule, env);
      logEvent("info", { event: "execution_finished", ...result, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      logEvent("error", { event: "execution_failed", code: safeErrorCode(error), ...diagnostic(error), durationMs: Date.now() - started });
      throw new Error(`Falha na execução da regra ${rule}; consulte o runId ${runId}`);
    }
  });
}
