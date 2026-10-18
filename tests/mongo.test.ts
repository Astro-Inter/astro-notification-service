import { describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { collectionStore } from "../src/shared/mongo";
import { notificationId } from "../src/shared/notification-id";
import type { NotificationIntent } from "../src/shared/types";

const intent: NotificationIntent = {
  document: { id_usuario: 2, titulo: "Treinamento pendente", mensagem: "Conclua o treinamento pendente.",
    data_criacao: new Date("2026-06-25T12:19:40.233Z"), id_evento: 1 },
  deduplicationKey: "example",
};

function setup() {
  const notifications = { createIndex: vi.fn(), findOne: vi.fn().mockResolvedValue(null), insertOne: vi.fn() };
  const collection = vi.fn((name: string) => notifications);
  const db = { collection } as unknown as Db;
  return { notifications, collection, store: collectionStore(db, async () => {}) };
}

describe("persistência sem coleções de apoio", () => {
  it("abre somente notificacoes e mantém seus índices", async () => {
    const { store, notifications, collection } = setup();
    await store.ensureIndexes();
    expect(collection.mock.calls).toEqual([["notificacoes"]]);
    expect(notifications.createIndex).toHaveBeenCalledTimes(2);
    expect(notifications.createIndex).toHaveBeenCalledWith({ chave_deduplicacao: 1 }, {
      name: "uq_notificacoes_chave_deduplicacao", unique: true,
      partialFilterExpression: { chave_deduplicacao: { $type: "string" } },
    });
  });

  it("grava somente o contrato solicitado com ID estável", async () => {
    const { store, notifications } = setup();
    const extra = { ...intent, document: { ...intent.document, workspace_id: 999, chave_deduplicacao: "não persistir" } };
    expect(await store.insertOnce(extra)).toBe(true);
    expect(notifications.insertOne).toHaveBeenCalledWith({ _id: await notificationId("example"), ...intent.document });
  });

  it("omite id_evento quando não existe", async () => {
    const { store, notifications } = setup();
    const { id_evento: _, ...document } = intent.document;
    await store.insertOnce({ ...intent, document });
    expect(notifications.insertOne.mock.calls[0]![0]).not.toHaveProperty("id_evento");
  });

  it("preserva documentos legados reconhecidos pela consulta de compatibilidade", async () => {
    const { store, notifications } = setup();
    notifications.findOne.mockResolvedValueOnce({ _id: 42 });
    expect(await store.insertOnce(intent)).toBe(false);
    expect(notifications.insertOne).not.toHaveBeenCalled();
    expect(notifications.findOne.mock.calls[0]![0]).toMatchObject({ $or: [
      { chave_deduplicacao: "example" },
      { id_usuario: 2, mensagem: intent.document.mensagem, id_evento: 1 },
    ] });
  });

  it("reconhece o mesmo ID sem atualizar título ou data", async () => {
    const { store, notifications } = setup();
    const existing = { _id: await notificationId("example"), ...intent.document };
    notifications.findOne.mockResolvedValueOnce(null).mockResolvedValue(existing);
    expect(await store.insertOnce({ ...intent, document: { ...intent.document, titulo: "Outro título" } })).toBe(false);
    expect(notifications.insertOne).not.toHaveBeenCalled();
  });

  it("reconhece a gravação concorrente pelo índice nativo de _id", async () => {
    const { store, notifications } = setup();
    notifications.insertOne.mockRejectedValueOnce({ code: 11000, keyPattern: { _id: 1 } });
    notifications.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: await notificationId("example"), ...intent.document });
    expect(await store.insertOnce(intent)).toBe(false);
  });

  it("recusa ID ocupado por conteúdo incompatível", async () => {
    const { store, notifications } = setup();
    notifications.findOne.mockResolvedValueOnce(null)
      .mockResolvedValue({ _id: await notificationId("example"), ...intent.document, id_usuario: 99 });
    await expect(store.insertOnce(intent)).rejects.toMatchObject({ code: "NOTIFICATION_ID_COLLISION" });
    expect(notifications.insertOne).not.toHaveBeenCalled();
  });

  it.each([{ code: 11000, keyPattern: { mensagem: 1 } }, new Error("write failed")])(
    "propaga falhas de escrita que não são duplicatas de _id", async error => {
      const { store, notifications } = setup();
      notifications.insertOne.mockRejectedValueOnce(error);
      await expect(store.insertOnce(intent)).rejects.toEqual(error);
    });
});
