import { WorkerEntrypoint } from "cloudflare:workers";
import { bindings, dispatchDue, type SchedulerEnv } from "../scheduler/dispatch";

async function execute(env: SchedulerEnv, time: Date) {
  const runId = crypto.randomUUID();
  const started = Date.now();
  const result = await dispatchDue(env, time);
  console.log(JSON.stringify({ event: "scheduler_finished", runId, scheduledTime: time.toISOString(),
    durationMs: Date.now() - started, ...result }));
  if (result.status === "failed") throw new Error(`Falha em tarefas do disparador; consulte o runId ${runId}`);
  return result;
}

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

  async run(scheduledTime: number) { return execute(this.env, new Date(scheduledTime)); }
}

export default {
  async scheduled(controller, env) { await execute(env, new Date(controller.scheduledTime)); },
  fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ service: "astro-shared-scheduler", status: "ok" });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<SchedulerEnv>;
