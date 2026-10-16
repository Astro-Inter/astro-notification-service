import type { Env, RuleId } from "./types";
import { executeRule } from "./execution";

export function createWorker(rule: RuleId): ExportedHandler<Env> {
  return {
    fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        return Response.json({ service: "astro-notification-service", rule, status: "ok" });
      }
      return new Response("Not found", { status: 404 });
    },
    async scheduled(_controller, env) {
      await executeRule(rule, env);
    },
  };
}
