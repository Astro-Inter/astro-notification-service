import { safeErrorCode } from "./errors";
import { runRule } from "./runner";
import type { Env, RuleId } from "./types";

export async function executeRule(rule: RuleId, env: Env) {
  const runId = crypto.randomUUID();
  const started = Date.now();
  try {
    const result = await runRule(rule, env);
    console.log(JSON.stringify({ event: "execution_finished", runId, ...result, durationMs: Date.now() - started }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ event: "execution_failed", rule, runId,
      code: safeErrorCode(error), durationMs: Date.now() - started }));
    throw new Error(`Falha na execução da regra ${rule}; consulte o runId ${runId}`);
  }
}
