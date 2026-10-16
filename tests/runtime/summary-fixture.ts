import { WorkerEntrypoint } from "cloudflare:workers";

export class ScheduledJob extends WorkerEntrypoint {
  async run() { return { service: "astro-session-summary-service", status: "skipped" }; }
  async status() { return { service: "astro-session-summary-service", enabled: false }; }
}

export default { fetch() { return new Response("Not found", { status: 404 }); } };
