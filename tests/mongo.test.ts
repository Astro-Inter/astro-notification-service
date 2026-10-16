import { describe, expect, it, vi } from "vitest";
import type { Collection } from "mongodb";
import { collectionStore } from "../src/shared/mongo";
import type { NotificationDocument } from "../src/shared/types";

describe("persistência idempotente", () => {
  it("preserva documentos antigos e exige unicidade apenas para as novas chaves", async () => {
    const createIndex = vi.fn().mockResolvedValue("index");
    const store = collectionStore({ createIndex } as unknown as Collection<NotificationDocument>, async () => {});
    await store.ensureIndexes();
    expect(createIndex.mock.calls[0]).toEqual([
      { chave_deduplicacao: 1 },
      { name: "uq_notificacoes_chave_deduplicacao", unique: true,
        partialFilterExpression: { chave_deduplicacao: { $type: "string" } } },
    ]);
  });
  it("considera a disputa pelo mesmo aviso uma duplicata e propaga outras falhas", async () => {
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValueOnce({ upsertedCount: 0 })
      .mockRejectedValueOnce({ code: 11000, keyPattern: { chave_deduplicacao: 1 } })
      .mockRejectedValueOnce(new Error("connection failed"))
      .mockRejectedValueOnce({ code: 11000, keyPattern: { other_unique_field: 1 } });
    const store = collectionStore({ updateOne } as unknown as Collection<NotificationDocument>, async () => {});
    const document = { chave_deduplicacao: "example" } as NotificationDocument;
    expect(await store.insertOnce(document)).toBe(true);
    expect(await store.insertOnce(document)).toBe(false);
    expect(await store.insertOnce(document)).toBe(false);
    await expect(store.insertOnce(document)).rejects.toThrow("connection failed");
    await expect(store.insertOnce(document)).rejects.toMatchObject({ code: 11000 });
    expect(updateOne.mock.calls[0]![1]).toEqual({ $setOnInsert: document });
  });
});
