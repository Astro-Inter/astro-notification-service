import { ServiceError } from "../shared/errors";
import type { NotificationIntent, NotificationPayload } from "../shared/types";
import type { DeliveryLedger } from "./ledger";

export interface NotificationWriter {
  ensureIndexes(): Promise<void>;
  maxSequentialId(): Promise<number>;
  findExisting(intent: NotificationIntent): Promise<{ id: number | null; precise: boolean } | null>;
  write(id: number, document: NotificationPayload): Promise<boolean>;
  close(): Promise<void>;
}

export async function deliverNotification(intent: NotificationIntent, ledger: DeliveryLedger,
  open: () => Promise<NotificationWriter>, sync: () => Promise<void>): Promise<boolean> {
  if (typeof intent.deduplicationKey !== "string" || !intent.deduplicationKey || intent.deduplicationKey.length > 4096) {
    throw new ServiceError("INVALID_NOTIFICATION_KEY", "Chave inválida");
  }
  const existing = ledger.get(intent.deduplicationKey);
  // Uma entrega confirmada independe da existência atual do aviso no MongoDB.
  if (existing?.state === "confirmed") return false;
  const document = intent.document;
  if (!Number.isSafeInteger(document.id_usuario) || document.id_usuario < 1
    || (document.id_evento !== undefined && (!Number.isSafeInteger(document.id_evento) || document.id_evento < 1))
    || typeof document.titulo !== "string" || !document.titulo || typeof document.mensagem !== "string" || !document.mensagem
    || !(document.data_criacao instanceof Date) || !Number.isFinite(document.data_criacao.getTime())) {
    throw new ServiceError("INVALID_NOTIFICATION", "Notificação inválida");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    document.id_usuario, document.id_evento ?? null, document.mensagem, document.titulo,
  ])));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (existing && existing.fingerprint !== fingerprint) throw new ServiceError("PENDING_CONTENT_MISMATCH", "Conteúdo da reserva pendente mudou");
  const writer = await open();
  try {
    await writer.ensureIndexes();
    if (!ledger.initialized()) ledger.initialize(await writer.maxSequentialId());
    if (!existing) {
      const old = await writer.findExisting(intent);
      // Um ID já importado pertence à sua chave original, inclusive entre faixas de antecedência.
      if (old && (old.precise || old.id === null || !ledger.owner(old.id))) {
        ledger.importConfirmed([{ key: intent.deduplicationKey, id: old.id }]);
        await sync();
        return false;
      }
    }
    const reservation = ledger.reserve(intent.deduplicationKey, fingerprint, document.data_criacao.toISOString());
    if (reservation.state === "confirmed") return false;
    if (reservation.fingerprint !== fingerprint) throw new ServiceError("PENDING_CONTENT_MISMATCH", "Conteúdo da reserva pendente mudou");
    if (reservation.id === null) throw new ServiceError("RESERVATION_ID_MISSING", "ID da reserva ausente");
    // Persistir o ID antes de qualquer escrita externa permite retomar a mesma reserva.
    await sync();
    const inserted = await writer.write(reservation.id, { ...document, data_criacao: new Date(reservation.createdAt) });
    ledger.confirm(intent.deduplicationKey);
    await sync();
    return inserted;
  } finally { await writer.close(); }
}
