import { Client } from "pg";
import { postgresOptions } from "../shared/postgres";
import { positiveId } from "../shared/config";
import { ServiceError } from "../shared/errors";
import type { Env, NotificationIntent } from "../shared/types";
import { pendingRecipientsQuery } from "./query";
import { FirebaseGateway, PUSH_BODY, PUSH_TITLE, type FirebaseEnv } from "./firebase";
import { PushLedger, type Recipient } from "./ledger";

export interface PushEnv extends Env, FirebaseEnv {
  PUSH_CONTROL: { deliverWithReceipt(intent: NotificationIntent): Promise<{ inserted: boolean; id: number | null }> };
}
export interface PushSource { page(after: string): Promise<Recipient[]>; current(id: string): Promise<Recipient | null>; close(): Promise<void> }
export async function openPushSource(env: PushEnv): Promise<PushSource> {
  const client = new Client(postgresOptions(env));
  client.on("error", () => {});
  await client.connect().catch(async error => { await client.end(); throw error; });
  const query = async (after: string, user?: string) => {
    const request = pendingRecipientsQuery(after, 100, user);
    await client.query("BEGIN READ ONLY");
    try { const result = await client.query<Recipient>(request.text, request.values); await client.query("COMMIT"); return result.rows; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return { page: after => query(after), current: async id => (await query("0", id))[0] ?? null, close: () => client.end() };
}
interface PushDependencies {
  source: () => Promise<PushSource>;
  gateway: Pick<FirebaseGateway, "devices" | "send" | "removeInvalid">;
  sync: () => Promise<void>;
}
export async function runPendingPush(env: PushEnv, ledger: PushLedger, time: number, dependencies: PushDependencies) {
  const result = { status: "completed", candidates: 0, inserted: 0, duplicates: 0, sent: 0, invalid: 0, missingTokens: 0, failures: 0 };
  if (!Number.isFinite(time) || time < 0) throw new ServiceError("INVALID_PUSH_TIME", "Horário inválido");
  const now = Math.floor(time / 3600000) * 3600000;
  const cycle = ledger.cycle(now);
  if (now < cycle.id) return { ...result, status: "skipped", reason: "stale_schedule" };
  if (cycle.scanned && !ledger.pending(cycle.id).length) return { ...result, status: "skipped", reason: "not_due" };
  const source = await dependencies.source();
  try {
    let after = cycle.after_id;
    if (!cycle.scanned) {
      let complete = false;
      for (let batch = 0; batch < 100; batch++) {
        const rows = await source.page(after);
        for (const row of rows) {
          if (!/^[1-9]\d*$/.test(row.user_id) || BigInt(row.user_id) <= BigInt(after) || !row.uid) throw new ServiceError("PAGINATION_STALLED", "Paginação sem avanço");
          after = row.user_id;
        }
        complete = rows.length < 100;
        ledger.add(cycle.id, rows, after, complete);
        await dependencies.sync();
        if (complete) break;
      }
      if (!complete) throw new ServiceError("BATCH_LIMIT_REACHED", "A leitura continuará na próxima execução");
    }
    for (const recipient of ledger.pending(cycle.id)) {
      result.candidates++;
      const current = await source.current(recipient.user_id);
      if (!current || current.uid !== recipient.uid) { ledger.done(cycle.id, recipient.user_id); continue; }
      try {
        const devices = await dependencies.gateway.devices(recipient.uid);
        if (!devices.length) { result.missingTokens++; ledger.done(cycle.id, recipient.user_id); continue; }
        const receipt = await env.PUSH_CONTROL.deliverWithReceipt({ deduplicationKey: JSON.stringify(["pending-events-push", cycle.id, recipient.user_id]),
          document: { id_usuario: positiveId(recipient.user_id), titulo: PUSH_TITLE, mensagem: PUSH_BODY, data_criacao: new Date(now) } });
        if (receipt.id === null || !Number.isSafeInteger(receipt.id)) throw new ServiceError("PUSH_RECEIPT_MISSING", "ID de notificação ausente");
        if (receipt.inserted) result.inserted++;
        for (const device of devices) {
          if (!ledger.attempt(cycle.id, recipient.user_id, device.id, now)) { result.duplicates++; continue; }
          await dependencies.sync();
          try {
            const outcome = await dependencies.gateway.send(recipient.uid, cycle.id, receipt.id, device);
            if (outcome === "accepted") { ledger.result(cycle.id, recipient.user_id, device.id, "accepted"); result.sent++; }
            else if (outcome === "invalid") {
              await dependencies.gateway.removeInvalid(recipient.uid, device);
              ledger.result(cycle.id, recipient.user_id, device.id, "invalid"); result.invalid++;
            } else {
              if (typeof outcome === "object") ledger.defer(cycle.id, recipient.user_id, device.id, now + outcome.retryAfterMs);
              result.failures++;
            }
          } catch (error) {
            if (error instanceof ServiceError && ["FCM_PERMISSION", "FIREBASE_AUTH", "FIREBASE_CONFIG", "FCM_PAYLOAD"].includes(error.code)) throw error;
            result.failures++;
          }
          await dependencies.sync();
        }
        if (!ledger.retryPending(cycle.id, recipient.user_id)) ledger.done(cycle.id, recipient.user_id);
      } catch (error) {
        if (error instanceof ServiceError && ["FCM_PERMISSION", "FIREBASE_AUTH", "FIREBASE_CONFIG", "FCM_PAYLOAD"].includes(error.code)) throw error;
        result.failures++;
      }
      await dependencies.sync();
    }
    return result;
  } finally { await source.close(); }
}
