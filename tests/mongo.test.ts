import { describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { collectionWriter } from "../src/shared/mongo";
import { notificationId } from "../src/shared/notification-id";
const document = { id_usuario: 2, titulo: "Treinamento", mensagem: "Conclua o treinamento.", data_criacao: new Date(), id_evento: 1 };
function setup() {
  const notifications = { createIndex: vi.fn(), findOne: vi.fn().mockResolvedValue(null), insertOne: vi.fn() };
  const collection = vi.fn((name: string) => notifications);
  return { notifications, collection, writer: collectionWriter({ collection } as unknown as Db, async () => {}) };
}
describe("escrita MongoDB em uma coleção", () => {
  it("abre somente notificacoes e cria seus índices", async () => {
    const { writer, collection, notifications } = setup(); await writer.ensureIndexes();
    expect(collection.mock.calls).toEqual([["notificacoes"]]); expect(notifications.createIndex).toHaveBeenCalledTimes(2);
  });
  it("grava somente os campos solicitados com o ID reservado", async () => {
    const { writer, notifications } = setup();
    await writer.write(43, { ...document, workspace_id: 999 } as typeof document);
    expect(notifications.insertOne).toHaveBeenCalledWith({ _id: 43, ...document });
  });
  it("omite id_evento ausente", async () => {
    const { writer, notifications } = setup(); const { id_evento: _, ...withoutEvent } = document;
    await writer.write(43, withoutEvent); expect(notifications.insertOne.mock.calls[0]![0]).not.toHaveProperty("id_evento");
  });
  it("retorna o maior ID sequencial e recusa falta de precisão", async () => {
    const { writer, notifications } = setup();
    notifications.findOne.mockResolvedValueOnce({ _id: 42 }); expect(await writer.maxSequentialId()).toBe(42);
    notifications.findOne.mockResolvedValueOnce({ _id: 1.5 }); await expect(writer.maxSequentialId()).rejects.toThrow();
  });
  it("reconhece IDs calculados na versão anterior", async () => {
    const { writer, notifications } = setup(); const id = await notificationId("example");
    notifications.findOne.mockResolvedValueOnce({ _id: id, ...document });
    expect(await writer.findExisting({ document, deduplicationKey: "example" })).toEqual({ id, precise: true });
  });
  it("reconhece gravação concorrente ou tentativa anterior pelo mesmo ID", async () => {
    const { writer, notifications } = setup();
    notifications.insertOne.mockRejectedValueOnce({ code: 11000, keyPattern: { _id: 1 } });
    notifications.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 43, ...document });
    expect(await writer.write(43, document)).toBe(false);
  });
  it("recusa ID ocupado por outro conteúdo", async () => {
    const { writer, notifications } = setup(); notifications.findOne.mockResolvedValue({ _id: 43, ...document, id_usuario: 99 });
    await expect(writer.write(43, document)).rejects.toMatchObject({ code: "NOTIFICATION_ID_COLLISION" });
    expect(notifications.insertOne).not.toHaveBeenCalled();
  });
  it.each([{ code: 11000, keyPattern: { mensagem: 1 } }, new Error("write_failed")])("propaga falhas de escrita", async error => {
    const { writer, notifications } = setup(); notifications.insertOne.mockRejectedValueOnce(error);
    await expect(writer.write(43, document)).rejects.toEqual(error);
  });
});
