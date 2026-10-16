import { randomUUID } from "node:crypto";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectionStore } from "../../src/shared/mongo";
import type { NotificationIntent, NotificationStore } from "../../src/shared/types";

// Só executa mediante opção explícita. Nunca escreve nas coleções de negócio.
describe.skipIf(process.env.MONGO_CONTRACT_TEST !== "true")("contrato no MongoDB real, em coleções temporárias", () => {
  let client: MongoClient;
  let db: Db;
  let store: NotificationStore;
  let names: { notifications: string; deliveries: string; counters: string };
  const intent: NotificationIntent = { deduplicationKey: "event-1", document: {
    id_usuario: 2, mensagem: "Conclua o treinamento pendente.",
    data_criacao: new Date("2026-06-25T12:19:40.233Z"), idevento: 1, titulo: "Treinamento pendente",
  } };

  beforeAll(async () => {
    process.loadEnvFile(".env");
    if (!process.env.MONGODB_URI || !process.env.MONGODB_DATABASE) throw new Error("Configure o MongoDB para o teste explícito");
    client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 8, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db(process.env.MONGODB_DATABASE);
  }, 20000);

  beforeEach(async () => {
    const prefix = `__astro_contract_${randomUUID().replaceAll("-", "")}`;
    names = { notifications: `${prefix}_notifications`, deliveries: `${prefix}_deliveries`, counters: `${prefix}_counters` };
    store = collectionStore(db, client, async () => {}, names);
    await store.ensureIndexes();
  }, 20000);

  afterEach(async () => {
    if (!names || !db) return;
    for (const name of Object.values(names)) {
      if (!/^__astro_contract_[a-f0-9]{32}_(notifications|deliveries|counters)$/.test(name)) {
        throw new Error("Nome de coleção temporária inválido");
      }
      await db.collection(name).drop().catch(error => { if (error.code !== 26) throw error; });
    }
  }, 20000);
  afterAll(async () => { await client?.close(); });

  it("persiste somente os campos solicitados, com e sem evento, e conserva a data nas reexecuções", async () => {
    expect(await store.insertOnce(intent)).toBe(true);
    expect(await store.insertOnce({ ...intent, document: { ...intent.document, titulo: "Não deve substituir" } })).toBe(false);
    const withEvent = await db.collection(names.notifications).findOne({});
    expect(withEvent).toEqual({ _id: 1, ...intent.document });
    const { idevento: _, ...document } = intent.document;
    expect(await store.insertOnce({ deduplicationKey: "compliance-1", document })).toBe(true);
    const withoutEvent = await db.collection(names.notifications).findOne({ titulo: document.titulo, idevento: { $exists: false } });
    expect(withoutEvent).toEqual({ _id: 2, ...document });
  }, 30000);

  it("deduplica a mesma chave concorrente e aloca IDs distintos para chaves diferentes", async () => {
    const same = await Promise.all(Array.from({ length: 6 }, () => store.insertOnce(intent)));
    expect(same.filter(Boolean)).toHaveLength(1);
    const distinct = await Promise.all(Array.from({ length: 6 }, (_, i) => store.insertOnce({ ...intent, deduplicationKey: `other-${i}` })));
    expect(distinct.every(Boolean)).toBe(true);
    const rows = await db.collection(names.notifications).find().toArray();
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map(row => row._id)).size).toBe(7);
    expect(rows.every(row => Number.isSafeInteger(row._id))).toBe(true);
  }, 60000);

  it("reconhece as chaves antigas e inicializa acima de IDs numéricos existentes", async () => {
    const notifications = db.collection<{ _id: number | ObjectId; chave_deduplicacao?: string }>(names.notifications);
    const oldId = new ObjectId();
    await notifications.insertMany([{ _id: 100 }, { _id: oldId, chave_deduplicacao: "old-key" }]);
    await Promise.all([store.ensureIndexes(), store.ensureIndexes()]);
    expect(await store.insertOnce({ ...intent, deduplicationKey: "old-key" })).toBe(false);
    expect(await store.insertOnce(intent)).toBe(true);
    expect(await notifications.findOne({ _id: 101 })).not.toBeNull();
    expect(await notifications.findOne({ _id: oldId })).toEqual({ _id: oldId, chave_deduplicacao: "old-key" });
  }, 30000);

  it("reverte contador e controle se a gravação falha e permite repetir a mesma chave", async () => {
    await db.collection(names.notifications).createIndex({ mensagem: 1 }, { unique: true });
    expect(await store.insertOnce(intent)).toBe(true);
    const second = { ...intent, deduplicationKey: "retry-key" };
    await expect(store.insertOnce(second)).rejects.toMatchObject({ code: 11000 });
    expect(await db.collection<{ _id: string }>(names.deliveries).findOne({ _id: "retry-key" })).toBeNull();
    expect(await db.collection(names.notifications).countDocuments()).toBe(1);
    expect(await store.insertOnce({ ...second, document: { ...second.document, mensagem: "Outra mensagem" } })).toBe(true);
    expect((await db.collection(names.notifications).findOne({ mensagem: "Outra mensagem" }))?._id).toBe(2);
  }, 30000);

  it("não grava nada quando o contador atinge o limite de precisão", async () => {
    await db.collection<{ _id: string; value: number }>(names.counters)
      .updateOne({ _id: names.notifications }, { $set: { value: Number.MAX_SAFE_INTEGER } });
    await expect(store.insertOnce(intent)).rejects.toThrow("Contador");
    expect(await db.collection(names.deliveries).countDocuments()).toBe(0);
    expect(await db.collection(names.notifications).countDocuments()).toBe(0);
  }, 30000);
});
