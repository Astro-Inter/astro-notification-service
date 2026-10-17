import { WorkerEntrypoint } from "cloudflare:workers";
import { bindings, type SchedulerEnv } from "../scheduler/dispatch";
import { executeScheduler } from "../scheduler/execution";

// Controle interno para diagnóstico e reexecução; não possui rota HTTP pública.
export class SchedulerControl extends WorkerEntrypoint<SchedulerEnv> {
  async status() {
    return { service: "astro-shared-scheduler", enabled: this.env.ENABLED === "true",
      dailyHourUTC: this.env.DAILY_HOUR_UTC ?? "11" };
  }

  async inspect() {
    const results = await Promise.allSettled(bindings.map(async job => ({ job, state: await this.env[job].status() })));
    return results.map((result, index) => result.status === "fulfilled"
      ? result.value : { job: bindings[index]!, state: { status: "unavailable" } });
  }

  async run(scheduledTime: number) { return executeScheduler(this.env, new Date(scheduledTime)); }
}

export default {
  async scheduled(controller, env) { await executeScheduler(env, new Date(controller.scheduledTime)); },
  fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ service: "astro-shared-scheduler", status: "ok" });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<SchedulerEnv>;
