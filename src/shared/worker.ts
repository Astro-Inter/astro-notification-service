import type { Env, RuleId } from "./types";
import { runRule } from "./runner";
import { safeErrorCode } from "./errors";

export function createWorker(rule: RuleId): ExportedHandler<Env> {
  return {
    fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        return Response.json({ service: "astro-notification-service", rule, status: "ok" });
      }
      return new Response("Not found", { status: 404 });
    },
    async scheduled(_controller, env) {
      const runId = crypto.randomUUID();
      const started = Date.now();
      try {
        const result = await runRule(rule, env);
        console.log(JSON.stringify({ event: "execution_finished", runId, ...result, durationMs: Date.now() - started }));
      } catch (error) {
        console.error(JSON.stringify({ event: "execution_failed", rule, runId,
          code: safeErrorCode(error), durationMs: Date.now() - started }));
        // Mensagem sanitizada também no erro entregue ao runtime do Cloudflare.
        throw new Error(`Falha na execução da regra ${rule}; consulte o runId ${runId}`);
      }
    },
  };
}
