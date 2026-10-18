import type { Db } from "mongodb";
import { ServiceError } from "./errors";
import { notificationId, notificationIdFloor } from "./notification-id";
import type { Env, NotificationDocument, NotificationStore } from "./types";

export const notificationCollection = "notificacoes";

export function collectionStore(db: Db, close: () => Promise<void>, name = notificationCollection): NotificationStore {
  const notifications = db.collection<NotificationDocument>(name);
  return {
    async ensureIndexes() {
      // Mantém a busca dos avisos da versão anterior, sem reescrever documentos.
      await notifications.createIndex({ chave_deduplicacao: 1 }, {
        name: "uq_notificacoes_chave_deduplicacao", unique: true,
        partialFilterExpression: { chave_deduplicacao: { $type: "string" } },
      });
      await notifications.createIndex({ id_usuario: 1, data_criacao: -1, _id: -1 }, { name: "idx_notificacoes_usuario_criacao" });
    },
    async insertOnce({ document, deduplicationKey }) {
      // Compatibilidade com avisos anteriores, sem alterar seus IDs ou documentos.
      const legacy = await notifications.findOne({ $or: [
        { chave_deduplicacao: deduplicationKey },
        { _id: { $gte: 1, $lt: notificationIdFloor }, id_usuario: document.id_usuario,
          mensagem: document.mensagem, id_evento: document.id_evento ?? { $exists: false } },
      ] }, { projection: { _id: 1 } });
      if (legacy) return false;
      const id = await notificationId(deduplicationKey);
      const duplicate = async () => {
        const existing = await notifications.findOne({ _id: id });
        if (!existing || existing.id_usuario !== document.id_usuario
          || existing.id_evento !== document.id_evento || existing.mensagem !== document.mensagem) {
          throw new ServiceError("NOTIFICATION_ID_COLLISION", "ID de notificação ocupado por conteúdo incompatível");
        }
        return false;
      };
      if (await notifications.findOne({ _id: id }, { projection: { _id: 1 } })) return duplicate();
      try {
        await notifications.insertOne({ _id: id, id_usuario: document.id_usuario,
          mensagem: document.mensagem, data_criacao: document.data_criacao,
          ...(document.id_evento === undefined ? {} : { id_evento: document.id_evento }), titulo: document.titulo });
        return true;
      } catch (error) {
        const conflict = error as { code?: number; keyPattern?: Record<string, unknown> };
        if (conflict.code === 11000 && conflict.keyPattern?._id === 1) return duplicate();
        throw error;
      }
    },
    close,
  };
}

export async function openNotificationStore(env: Env): Promise<NotificationStore> {
  if (!env.MONGODB_URI || !env.MONGODB_DATABASE) throw new Error("Configure MONGODB_URI e MONGODB_DATABASE");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000, socketTimeoutMS: 15000,
  });
  try {
    await client.connect();
    return collectionStore(client.db(env.MONGODB_DATABASE), () => client.close());
  } catch (error) {
    await client.close();
    throw error;
  }
}
