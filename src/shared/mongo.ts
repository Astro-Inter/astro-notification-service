import type { Collection } from "mongodb";
import type { Env, NotificationDocument, NotificationStore } from "./types";

export const deduplicationIndex = {
  name: "uq_notificacoes_chave_deduplicacao",
  unique: true,
  partialFilterExpression: { chave_deduplicacao: { $type: "string" } },
} as const;

export function collectionStore(collection: Collection<NotificationDocument>, close: () => Promise<void>): NotificationStore {
  return {
    async ensureIndexes() {
      // O filtro parcial mantém compatibilidade com notificações antigas sem chave.
      await collection.createIndex({ chave_deduplicacao: 1 }, deduplicationIndex);
      await collection.createIndex({ id_usuario: 1, data_criacao: -1, _id: -1 }, { name: "idx_notificacoes_usuario_criacao" });
    },
    async insertOnce(document) {
      try {
        const result = await collection.updateOne(
          { chave_deduplicacao: document.chave_deduplicacao },
          { $setOnInsert: document }, { upsert: true },
        );
        return result.upsertedCount === 1;
      } catch (error) {
        // Duas execuções podem disputar o mesmo upsert. Outros erros devem falhar.
        const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
        if (duplicate.code === 11000 && duplicate.keyPattern?.chave_deduplicacao === 1) return false;
        throw error;
      }
    },
    close,
  };
}

export async function openNotificationStore(env: Env): Promise<NotificationStore> {
  if (!env.MONGODB_URI || !env.MONGODB_DATABASE) throw new Error("Configure MONGODB_URI e MONGODB_DATABASE");
  // O driver inicializa estado dependente do runtime; importar dentro da execução.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000, socketTimeoutMS: 15000,
  });
  try {
    await client.connect();
    return collectionStore(client.db(env.MONGODB_DATABASE).collection<NotificationDocument>("notificacoes"), () => client.close());
  } catch (error) {
    await client.close();
    throw error;
  }
}
