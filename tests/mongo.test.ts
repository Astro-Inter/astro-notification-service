import { describe, expect, it, vi } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { collectionNames, collectionStore } from "../src/shared/mongo";
import type { NotificationIntent } from "../src/shared/types";

const intent: NotificationIntent = {
  document: { id_usuario: 2, titulo: "Treinamento pendente", mensagem: "Conclua o treinamento pendente.",
    data_criacao: new Date("2026-06-25T12:19:40.233Z"), idevento: 1 },
  deduplicationKey: "example",
};

function setup() {
  const notifications = { createIndex: vi.fn(), findOne: vi.fn().mockResolvedValue(null), insertOne: vi.fn() };
  const deliveries = { createIndex: vi.fn(), findOne: vi.fn().mockResolvedValue(null), insertOne: vi.fn() };
  const counters = { updateOne: vi.fn(), findOneAndUpdate: vi.fn().mockResolvedValue({ _id: "notificacoes", value: 43 }) };
  const collections = { [collectionNames.notifications]: notifications, [collectionNames.deliveries]: deliveries,
    [collectionNames.counters]: counters };
  const db = { collection: (name: keyof typeof collections) => collections[name] } as unknown as Db;
  const session = { withTransaction: vi.fn(async callback => callback()) };
  const client = { withSession: vi.fn(async callback => callback(session)) } as unknown as MongoClient;
  return { notifications, deliveries, counters, session, store: collectionStore(db, client, async () => {}) };
}

describe("persistência idempotente", () => {
  it("inicializa o contador acima dos IDs numéricos existentes e separa os índices de controle", async () => {
    const { store, notifications, counters, deliveries } = setup();
    notifications.findOne.mockResolvedValueOnce({ _id: 42 });
    await store.ensureIndexes();
    expect(notifications.findOne).toHaveBeenCalledWith({ $or: [
      { _id: { $type: "double" } }, { _id: { $type: "int" } },
      { _id: { $type: "long" } }, { _id: { $type: "decimal" } },
    ] },
      { sort: { _id: -1 }, projection: { _id: 1 } });
    expect(counters.updateOne).toHaveBeenCalledWith({ _id: "notificacoes" }, { $max: { value: 42 } }, { upsert: true });
    expect(deliveries.createIndex).toHaveBeenCalledWith({ notification_id: 1 },
      { name: "uq_notificacoes_controle_id", unique: true });
  });
  it("grava somente o modelo solicitado e usa a mesma transação para ID, controle e aviso", async () => {
    const { store, notifications, deliveries, counters, session } = setup();
    const extra = { ...intent, document: { ...intent.document, workspace_id: 999, chave_deduplicacao: "não persistir" } };
    expect(await store.insertOnce(extra)).toBe(true);
    expect(notifications.insertOne).toHaveBeenCalledWith({ _id: 43, ...intent.document }, { session });
    expect(deliveries.insertOne).toHaveBeenCalledWith({ _id: "example", notification_id: 43 }, { session });
    expect(counters.findOneAndUpdate.mock.calls[0]![2]).toMatchObject({ session });
    expect(session.withTransaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
    }));
  });
  it("tolera criação concorrente do contador sem diminuir seu valor", async () => {
    const { store, counters } = setup();
    counters.updateOne.mockRejectedValueOnce({ code: 11000 });
    await store.ensureIndexes();
    expect(counters.updateOne.mock.calls[1]).toEqual([{ _id: "notificacoes" }, { $max: { value: 0 } }]);
  });
  it("recusa IDs existentes fora da precisão suportada antes de inicializar o contador", async () => {
    const { store, notifications, counters } = setup();
    notifications.findOne.mockResolvedValueOnce({ _id: Number.MAX_SAFE_INTEGER + 1 });
    await expect(store.ensureIndexes()).rejects.toThrow("Identificador");
    expect(counters.updateOne).not.toHaveBeenCalled();
  });
  it("omite idevento quando não existe", async () => {
    const { store, notifications } = setup();
    const { idevento: _, ...document } = intent.document;
    await store.insertOnce({ ...intent, document });
    expect(notifications.insertOne.mock.calls[0]![0]).not.toHaveProperty("idevento");
  });
  it.each(["controle", "legado"])("não recria notificações reconhecidas pelo %s", async origin => {
    const { store, notifications, deliveries, counters } = setup();
    if (origin === "controle") deliveries.findOne.mockResolvedValueOnce({ _id: "example", notification_id: 1 });
    else notifications.findOne.mockResolvedValueOnce({ _id: "object-id-legado" });
    expect(await store.insertOnce(intent)).toBe(false);
    expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notifications.insertOne).not.toHaveBeenCalled();
  });
  it("só aceita colisão de chave como duplicata quando a entrega está confirmada", async () => {
    const { store, deliveries, notifications } = setup();
    deliveries.insertOne.mockRejectedValueOnce({ code: 11000 });
    deliveries.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: "example", notification_id: 1 });
    expect(await store.insertOnce(intent)).toBe(false);
    notifications.insertOne.mockRejectedValueOnce({ code: 11000 });
    await expect(store.insertOnce(intent)).rejects.toMatchObject({ code: 11000 });
  });
  it("propaga falha de gravação e recusa contador ausente ou sem precisão", async () => {
    const { store, notifications, counters } = setup();
    notifications.insertOne.mockRejectedValueOnce(new Error("write failed"));
    await expect(store.insertOnce(intent)).rejects.toThrow("write failed");
    for (const counter of [null, { value: Number.MAX_SAFE_INTEGER + 1 }]) {
      counters.findOneAndUpdate.mockResolvedValueOnce(counter);
      await expect(store.insertOnce(intent)).rejects.toThrow("Contador");
    }
  });
});
