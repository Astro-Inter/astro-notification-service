import type { Db, MongoClient } from "mongodb";
import type { Env, NotificationDocument, NotificationStore } from "./types";

interface Delivery { _id: string; notification_id: number }
interface Counter { _id: string; value: number }

export const collectionNames = {
  notifications: "notificacoes",
  deliveries: "notificacoes_controle",
  counters: "notificacoes_contadores",
} as const;

export function collectionStore(db: Db, client: MongoClient, close: () => Promise<void>, names: {
  notifications: string; deliveries: string; counters: string;
} = collectionNames): NotificationStore {
  const notifications = db.collection<NotificationDocument>(names.notifications);
  const deliveries = db.collection<Delivery>(names.deliveries);
  const counters = db.collection<Counter>(names.counters);
  const counterId = names.notifications;
  return {
    async ensureIndexes() {
      // Mantém a busca dos avisos da versão anterior, sem reescrever documentos.
      await notifications.createIndex({ chave_deduplicacao: 1 }, {
        name: "uq_notificacoes_chave_deduplicacao", unique: true,
        partialFilterExpression: { chave_deduplicacao: { $type: "string" } },
      });
      await notifications.createIndex({ id_usuario: 1, data_criacao: -1, _id: -1 }, { name: "idx_notificacoes_usuario_criacao" });
      await deliveries.createIndex({ notification_id: 1 }, { name: "uq_notificacoes_controle_id", unique: true });
      const largest = await notifications.findOne({ $or: [
        { _id: { $type: "double" } }, { _id: { $type: "int" } },
        { _id: { $type: "long" } }, { _id: { $type: "decimal" } },
      ] },
        { sort: { _id: -1 }, projection: { _id: 1 } });
      const floor = largest?._id ?? 0;
      if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Identificador numérico existente inválido");
      try {
        await counters.updateOne({ _id: counterId }, { $max: { value: floor } }, { upsert: true });
      } catch (error) {
        // Corrida na criação inicial do contador: o outro Worker já o criou.
        if ((error as { code?: number }).code !== 11000) throw error;
        await counters.updateOne({ _id: counterId }, { $max: { value: floor } });
      }
    },
    async insertOnce({ document, deduplicationKey }) {
      try {
        return await client.withSession(session => session.withTransaction(async () => {
          if (await deliveries.findOne({ _id: deduplicationKey }, { session })) return false;
          const legacy = await notifications.findOne(
            { chave_deduplicacao: deduplicationKey }, { session, projection: { _id: 1 } },
          );
          if (legacy) return false;
          const counter = await counters.findOneAndUpdate(
            { _id: counterId, value: { $lt: Number.MAX_SAFE_INTEGER } }, { $inc: { value: 1 } },
            { session, returnDocument: "after" },
          );
          if (!counter || !Number.isSafeInteger(counter.value) || counter.value < 1) {
            throw new Error("Contador de notificações indisponível ou fora do limite numérico");
          }
          await deliveries.insertOne({ _id: deduplicationKey, notification_id: counter.value }, { session });
          // Lista explícita: metadados internos nunca vazam para o documento público.
          await notifications.insertOne({
            _id: counter.value, id_usuario: document.id_usuario, mensagem: document.mensagem,
            data_criacao: document.data_criacao,
            ...(document.idevento === undefined ? {} : { idevento: document.idevento }),
            titulo: document.titulo,
          }, { session });
          return true;
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
          maxCommitTimeMS: 10000, timeoutMS: 20000 }));
      } catch (error) {
        // Uma chave disputada só é duplicata se sua entrega foi realmente confirmada.
        if ((error as { code?: number }).code === 11000
          && await deliveries.findOne({ _id: deduplicationKey })) return false;
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
    return collectionStore(client.db(env.MONGODB_DATABASE), client, () => client.close());
  } catch (error) {
    await client.close();
    throw error;
  }
}
