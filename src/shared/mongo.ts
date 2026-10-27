import { observe } from "./diagnostics";
import type { Db } from "mongodb";
import type { NotificationWriter } from "../control/delivery";
import { ServiceError } from "./errors";
import { notificationId, notificationIdFloor } from "./notification-id";
import type { NotificationDocument, NotificationPayload } from "./types";

export const notificationCollection = "notificacoes";

export function collectionWriter(db: Db, close: () => Promise<void>, name = notificationCollection): NotificationWriter {
  const notifications = db.collection<NotificationDocument>(name);
  const compatible = (existing: NotificationDocument | null, document: NotificationPayload) => {
    if (!existing || existing.id_usuario !== document.id_usuario || existing.id_evento !== document.id_evento
      || existing.mensagem !== document.mensagem) throw new ServiceError("NOTIFICATION_ID_COLLISION", "ID ocupado por conteúdo incompatível");
  };
  return {
    async ensureIndexes() {
      await notifications.createIndex({ chave_deduplicacao: 1 }, { name: "uq_notificacoes_chave_deduplicacao", unique: true,
        partialFilterExpression: { chave_deduplicacao: { $type: "string" } } });
      await notifications.createIndex({ id_usuario: 1, data_criacao: -1, _id: -1 }, { name: "idx_notificacoes_usuario_criacao" });
    },
    async maxSequentialId() {
      const last = await notifications.findOne({ _id: { $gte: 1, $lt: notificationIdFloor } }, { sort: { _id: -1 }, projection: { _id: 1 } });
      const id = last?._id ?? 0;
      if (!Number.isSafeInteger(id) || id < 0) throw new ServiceError("INVALID_ID_FLOOR", "ID existente sem precisão inteira");
      return id;
    },
    async findExisting({ document, deduplicationKey }) {
      // Compatibilidade com a primeira versão e com os IDs calculados da PR #6.
      const hashId = await notificationId(deduplicationKey);
      const precise = await notifications.findOne({ $or: [{ chave_deduplicacao: deduplicationKey }, { _id: hashId }] });
      if (precise) {
        if (precise._id === hashId) compatible(precise, document);
        return { id: typeof precise._id === "number" ? precise._id : null, precise: true };
      }
      const old = await notifications.findOne({ _id: { $gte: 1, $lt: notificationIdFloor }, id_usuario: document.id_usuario,
        mensagem: document.mensagem, id_evento: document.id_evento ?? { $exists: false } }, { projection: { _id: 1 } });
      return old ? { id: old._id, precise: false } : null;
    },
    async write(id, document) {
      if (!Number.isSafeInteger(id) || id < 1) throw new ServiceError("INVALID_NOTIFICATION_ID", "ID de notificação inválido");
      const existing = await notifications.findOne({ _id: id });
      if (existing) { compatible(existing, document); return false; }
      try {
        await notifications.insertOne({ _id: id, id_usuario: document.id_usuario, mensagem: document.mensagem,
          data_criacao: document.data_criacao, ...(document.id_evento === undefined ? {} : { id_evento: document.id_evento }), titulo: document.titulo });
        return true;
      } catch (error) {
        const conflict = error as { code?: number; keyPattern?: Record<string, unknown> };
        if (conflict.code !== 11000 || conflict.keyPattern?._id !== 1) throw error;
        compatible(await notifications.findOne({ _id: id }), document);
        return false;
      }
    },
    close,
  };
}

export async function openNotificationWriter(env: { MONGODB_URI?: string; MONGODB_DATABASE?: string }): Promise<NotificationWriter> {
  if (!env.MONGODB_URI || !env.MONGODB_DATABASE) throw new Error("Configure MONGODB_URI e MONGODB_DATABASE");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 1, minPoolSize: 0,
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 15000 });
  try { await observe("connect", "mongodb", () => client.connect()); return collectionWriter(client.db(env.MONGODB_DATABASE), () => client.close()); }
  catch (error) { await client.close(); throw error; }
}
