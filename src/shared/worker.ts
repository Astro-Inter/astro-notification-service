import type { Env, RuleId } from "./types";

export function createWorker(rule: RuleId): ExportedHandler<Env> {
  return {
    fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        return Response.json({ service: "astro-notification-service", rule, status: "ok" });
      }
      return new Response("Not found", { status: 404 });
    },
    async scheduled(_controller, env) {
      if (env.ENABLED !== "true") {
        console.log(JSON.stringify({ event: "execution_skipped", rule, reason: "disabled" }));
        return;
      }
      throw new Error(`Regra ainda não implementada: ${rule}`);
    },
  };
}
