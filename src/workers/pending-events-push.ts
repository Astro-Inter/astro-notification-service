import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { PushLedger } from "../push/ledger";
import { FirebaseGateway } from "../push/firebase";
import { openPushSource, runPendingPush, type PushEnv } from "../push/runner";
import { booleanSetting } from "../shared/config";
import { logEvent, withTelemetry } from "../shared/telemetry";
import { safeErrorCode } from "../shared/errors";

interface WorkerEnv extends PushEnv { PUSHES: DurableObjectNamespace<PendingPushCoordinator> }
export class PendingPushCoordinator extends DurableObject<WorkerEnv> {
  private readonly ledger: PushLedger;
  private readonly gateway: FirebaseGateway;
  private queue: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env); this.ledger = new PushLedger(ctx.storage); this.gateway = new FirebaseGateway(env);
  }
  run(time: number) {
    const result = this.queue.then(() => withTelemetry(this.env, "astro-notification-pending-events-push", { runId: crypto.randomUUID() }, async () => {
      if (!booleanSetting(this.env.ENABLED, false)) return { status: "skipped", reason: "disabled" };
      if (booleanSetting(this.env.DRY_RUN, true)) return { status: "skipped", reason: "dry_run" };
      try {
        const result = await runPendingPush(this.env, this.ledger, time, { source: () => openPushSource(this.env), gateway: this.gateway,
          sync: () => this.ctx.storage.sync() });
        logEvent("info", { event: "push_finished", ...result }); return result;
      } catch (error) {
        logEvent("error", { event: "push_failed", code: safeErrorCode(error) });
        throw new Error(`Falha no lembrete push: ${safeErrorCode(error)}`);
      }
    }));
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  status() { return { enabled: booleanSetting(this.env.ENABLED, false), dryRun: booleanSetting(this.env.DRY_RUN, true), ...this.ledger.status() }; }
}
export class PendingPushJob extends WorkerEntrypoint<WorkerEnv> {
  private actor() { return this.env.PUSHES.get(this.env.PUSHES.idFromName(`${this.env.APP_ENV ?? "production"}:pending-events:v1`)); }
  run(time = Date.now()) { return this.actor().run(time); }
  status() { return this.actor().status(); }
  async preview() {
    const source = await openPushSource(this.env);
    let candidates = 0; let after = "0";
    try {
      for (let page = 0; page < 100; page++) {
        const rows = await source.page(after); candidates += rows.length;
        if (rows.length < 100) return { status: "completed", dryRun: true, candidates };
        after = rows.at(-1)!.user_id;
      }
      throw new Error("Limite de lotes do preview atingido");
    } finally { await source.close(); }
  }
}
export default {
  fetch(request: Request) {
    return request.method === "GET" && new URL(request.url).pathname === "/health"
      ? Response.json({ service: "astro-notification-pending-events-push", status: "ok" }) : new Response("Not found", { status: 404 });
  },
};
