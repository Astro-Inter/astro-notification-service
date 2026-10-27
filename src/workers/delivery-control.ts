import { diagnostic } from "../shared/diagnostics";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DeliveryLedger, type Receipt } from "../control/ledger";
import { deliverNotification, type NotificationWriter } from "../control/delivery";
import { openNotificationWriter } from "../shared/mongo";
import { logEvent, withTelemetry, type GrafanaEnv } from "../shared/telemetry";
import { safeErrorCode } from "../shared/errors";
import type { NotificationIntent } from "../shared/types";

interface ControlEnv extends GrafanaEnv {
  MONGODB_URI?: string;
  MONGODB_DATABASE?: string;
  DELIVERIES: DurableObjectNamespace<NotificationCoordinator>;
}

export class NotificationCoordinator extends DurableObject<ControlEnv> {
  private readonly ledger: DeliveryLedger;
  private queue: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: ControlEnv) {
    super(ctx, env);
    this.ledger = new DeliveryLedger(ctx.storage);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    // Não manter uma transação SQLite aberta durante I/O externo. Uma falha não bloqueia a fila.
    const result = this.queue.then(work);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  protected openWriter(): Promise<NotificationWriter> { return openNotificationWriter(this.env); }
  deliver(intent: NotificationIntent): Promise<boolean> {
    return this.deliverWithReceipt(intent).then(receipt => receipt.inserted);
  }
  deliverWithReceipt(intent: NotificationIntent): Promise<{ inserted: boolean; id: number | null }> {
    return this.serialize(() => withTelemetry(this.env, "astro-notification-delivery-control", { runId: crypto.randomUUID() }, async () => {
      try {
        const inserted = await deliverNotification(intent, this.ledger, () => this.openWriter(), () => this.ctx.storage.sync());
        logEvent("info", { event: "delivery_finished", status: "completed", inserted: inserted ? 1 : 0, duplicates: inserted ? 0 : 1 });
        return { inserted, id: this.ledger.get(intent.deduplicationKey)?.id ?? null };
      } catch (error) {
        logEvent("error", { event: "delivery_failed", code: safeErrorCode(error), ...diagnostic(error) });
        throw new Error(`Falha no controle de entrega: ${safeErrorCode(error)}`);
      }
    }));
  }
  importConfirmed(receipts: Receipt[]) {
    return this.serialize(async () => { this.ledger.importConfirmed(receipts); await this.ctx.storage.sync(); return this.ledger.status(); });
  }
  initialize() {
    return this.serialize(async () => {
      const writer = await this.openWriter();
      try {
        await writer.ensureIndexes();
        this.ledger.initialize(await writer.maxSequentialId());
        await this.ctx.storage.sync();
        return this.ledger.status();
      } catch (error) { throw new Error(`Falha na inicialização: ${safeErrorCode(error)}`); }
      finally { await writer.close(); }
    });
  }
  status() { return this.serialize(async () => this.ledger.status()); }
}

export class DeliveryControl extends WorkerEntrypoint<ControlEnv> {
  private coordinator() { return this.env.DELIVERIES.get(this.env.DELIVERIES.idFromName(`${this.env.APP_ENV ?? "production"}:notificacoes:v1`)); }
  deliver(intent: NotificationIntent) { return this.coordinator().deliver(intent); }
  deliverWithReceipt(intent: NotificationIntent) { return this.coordinator().deliverWithReceipt(intent); }
  importConfirmed(receipts: Receipt[]) { return this.coordinator().importConfirmed(receipts); }
  initialize() { return this.coordinator().initialize(); }
  status() { return this.coordinator().status(); }
}

export default {
  fetch(request: Request) {
    return request.method === "GET" && new URL(request.url).pathname === "/health"
      ? Response.json({ service: "astro-notification-delivery-control", status: "ok" }) : new Response("Not found", { status: 404 });
  },
};
