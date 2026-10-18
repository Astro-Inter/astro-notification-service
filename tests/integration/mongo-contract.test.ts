import { randomUUID } from "node:crypto";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectionWriter } from "../../src/shared/mongo";
import { notificationId } from "../../src/shared/notification-id";
import { deliverNotification } from "../../src/control/delivery";
import { sqliteLedger } from "../helpers/ledger";
import type { NotificationIntent, NotificationStore } from "../../src/shared/types";

// Só executa mediante opção explícita. Nunca escreve nas coleções de negócio.
describe.skipIf(process.env.MONGO_CONTRACT_TEST !== "true")("contrato no MongoDB real, em coleção temporária", () => {
  let client: MongoClient;
  let db: Db;
  let store: NotificationStore;
  let name: string;
  let ledgerState: ReturnType<typeof sqliteLedger>;
  const intent: NotificationIntent = { deduplicationKey: "event-1", document: {
    id_usuario: 2, mensagem: "Conclua o treinamento pendente.",
    data_criacao: new Date("2026-06-25T12:19:40.233Z"), id_evento: 1, titulo: "Treinamento pendente",
  } };

  beforeAll(async () => {
    process.loadEnvFile(".env");
    if (!process.env.MONGODB_URI || !process.env.MONGODB_DATABASE) throw new Error("Configure o MongoDB para o teste explícito");
    client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 8, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db(process.env.MONGODB_DATABASE);
  }, 20000);

  beforeEach(async () => {
    name = `__astro_contract_${randomUUID().replaceAll("-", "")}`;
    ledgerState = sqliteLedger();
    const writer = collectionWriter(db, async () => {}, name);
    store = { ensureIndexes: () => writer.ensureIndexes(), close: async () => {},
      insertOnce: intent => deliverNotification(intent, ledgerState.ledger, async () => writer, async () => {}) };
    await store.ensureIndexes();
  }, 20000);

  afterEach(async () => {
    ledgerState?.close();
    if (!name || !db) return;
    if (!/^__astro_contract_[a-f0-9]{32}$/.test(name)) throw new Error("Nome de coleção temporária inválido");
    await db.collection(name).drop().catch(error => { if (error.code !== 26) throw error; });
  }, 20000);
  afterAll(async () => { await client?.close(); });

  it("persiste somente os campos solicitados, com e sem evento, e conserva a data nas reexecuções", async () => {
    expect(await store.insertOnce(intent)).toBe(true);
    expect(await store.insertOnce({ ...intent, document: { ...intent.document, titulo: "Não deve substituir" } })).toBe(false);
    expect(await db.collection(name).findOne({})).toEqual({ _id: 1, ...intent.document });
    const { id_evento: _, ...document } = intent.document;
    expect(await store.insertOnce({ deduplicationKey: "compliance-1", document })).toBe(true);
    expect(await db.collection(name).findOne({ id_evento: { $exists: false } }))
      .toEqual({ _id: 2, ...document });
  }, 30000);

  it("deduplica gravações concorrentes e separa etapas mesmo com mensagens iguais", async () => {
    const same = await Promise.all(Array.from({ length: 6 }, () => store.insertOnce(intent)));
    expect(same.filter(Boolean)).toHaveLength(1);
    const distinct = await Promise.all(Array.from({ length: 6 }, (_, i) => store.insertOnce({ ...intent, deduplicationKey: `stage-${i}` })));
    expect(distinct.every(Boolean)).toBe(true);
    const rows = await db.collection(name).find().toArray();
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map(row => row._id)).size).toBe(7);
    expect(rows.every(row => Number.isSafeInteger(row._id))).toBe(true);
    const collections = await db.listCollections({ name: { $regex: `^${name}` } }).toArray();
    expect(collections.map(row => row.name)).toEqual([name]);
  }, 60000);

  it("preserva documentos com chave antiga ou ID sequencial e reconhece ambos", async () => {
    const notifications = db.collection<{ _id: number | ObjectId; chave_deduplicacao?: string } & Record<string, unknown>>(name);
    const oldId = new ObjectId();
    const old = { _id: oldId, chave_deduplicacao: "old-key" };
    const sequential = { _id: 42, ...intent.document };
    await notifications.insertMany([sequential, old]);
    expect(await store.insertOnce({ ...intent, deduplicationKey: "old-key" })).toBe(false);
    expect(await store.insertOnce(intent)).toBe(false);
    expect(await notifications.findOne({ _id: 42 })).toEqual(sequential);
    expect(await notifications.findOne({ _id: oldId })).toEqual(old);
    expect(await notifications.countDocuments()).toBe(2);
  }, 30000);

  it("retoma a reserva após falha de escrita sem alterar o conteúdo nem trocar o ID", async () => {
    await db.collection(name).createIndex({ mensagem: 1 }, { unique: true });
    expect(await store.insertOnce(intent)).toBe(true);
    const second = { ...intent, deduplicationKey: "retry-key" };
    await expect(store.insertOnce(second)).rejects.toMatchObject({ code: 11000 });
    expect(await db.collection(name).countDocuments()).toBe(1);
    expect(ledgerState.ledger.get("retry-key")?.state).toBe("pending");
    await db.collection(name).dropIndex("mensagem_1");
    expect(await store.insertOnce(second)).toBe(true);
    expect(await db.collection<{ _id: number }>(name).findOne({ _id: 2 })).not.toBeNull();
  }, 30000);

  it("recusa colisão com outro conteúdo e impede recriar uma entrega confirmada após exclusão", async () => {
    const id = 1;
    ledgerState.ledger.initialize(0);

    // Colisão é testada no escritor; a entrega pendente mantém a reserva.
    const notifications = db.collection<{ _id: number } & Record<string, unknown>>(name);
    const other = { _id: id, ...intent.document, id_usuario: 99 };
    await notifications.insertOne(other);
    const writer = collectionWriter(db, async () => {}, name);
    await expect(writer.write(id, intent.document)).rejects.toMatchObject({ code: "NOTIFICATION_ID_COLLISION" });
    expect(await notifications.findOne({ _id: id })).toEqual(other);
    await notifications.deleteOne({ _id: id });
    expect(await store.insertOnce(intent)).toBe(true);
    await notifications.deleteOne({ _id: id });
    expect(await store.insertOnce(intent)).toBe(false);
  }, 30000);

  it("preserva IDs calculados pela versão anterior e memoriza a confirmação", async () => {
    const id = await notificationId(intent.deduplicationKey);
    const notifications = db.collection<{ _id: number } & Record<string, unknown>>(name);
    await notifications.insertOne({ _id: id, ...intent.document });
    expect(await store.insertOnce(intent)).toBe(false);
    expect(ledgerState.ledger.get(intent.deduplicationKey)).toMatchObject({ id, state: "confirmed" });
    await notifications.deleteOne({ _id: id });
    expect(await store.insertOnce(intent)).toBe(false);
    expect(await notifications.countDocuments()).toBe(0);
  }, 30000);
});
