import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverNotification, type NotificationWriter } from "../src/control/delivery";
import type { NotificationIntent } from "../src/shared/types";
import { sqliteLedger } from "./helpers/ledger";

const intent: NotificationIntent = { deduplicationKey: "rule-event-stage", document: {
  usuario_id: 2, mensagem: "Conclua o treinamento.", titulo: "Treinamento", data_criacao: new Date("2026-10-18T12:00:00Z"), evento_id: 1,
} };
const fixtures: ReturnType<typeof sqliteLedger>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function setup() {
  const state = sqliteLedger(); fixtures.push(state);
  const writer = { ensureIndexes: vi.fn(), maxSequentialId: vi.fn().mockResolvedValue(42),
    findExisting: vi.fn().mockResolvedValue(null), write: vi.fn().mockResolvedValue(true), close: vi.fn() } satisfies NotificationWriter;
  const sync = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn().mockResolvedValue(writer);
  return { ...state, writer, sync, open, deliver: (item = intent) => deliverNotification(item, state.ledger, open, sync) };
}

describe("entregas persistentes fora do MongoDB", () => {
  it("reserva acima do histórico, persiste antes da escrita e confirma depois", async () => {
    const { deliver, ledger, sync, writer } = setup();
    writer.write.mockImplementationOnce(async id => {
      expect(id).toBe(43); expect(ledger.get(intent.deduplicationKey)?.state).toBe("pending");
      expect(sync).toHaveBeenCalledTimes(1); return true;
    });
    expect(await deliver()).toBe(true);
    expect(ledger.get(intent.deduplicationKey)?.state).toBe("confirmed");
    expect(sync).toHaveBeenCalledTimes(2);
  });
  it("mantém o mesmo ID e a data ao retomar uma escrita que falhou, inclusive após reabrir o estado", async () => {
    const { deliver, writer, reopen, open, sync } = setup();
    writer.write.mockRejectedValueOnce(new Error("temporary_failure"));
    await expect(deliver()).rejects.toThrow("temporary_failure");
    expect(await deliverNotification({ ...intent, document: { ...intent.document, data_criacao: new Date("2026-10-19T12:00:00Z") } }, reopen(), open, sync)).toBe(true);
    expect(writer.write.mock.calls.map(call => call[0])).toEqual([43, 43]);
    expect(writer.write.mock.calls[1]![1].data_criacao).toEqual(intent.document.data_criacao);
  });
  it("retoma o mesmo ID quando Mongo gravou mas a confirmação persistente falhou", async () => {
    const { deliver, sync, writer, ledger } = setup();
    // Falhar antes de confirmar simula a janela após o Mongo responder e antes de persistir o recibo.
    const confirm = vi.spyOn(ledger, "confirm").mockImplementationOnce(() => { throw new Error("confirmation_failed"); });
    await expect(deliver()).rejects.toThrow("confirmation_failed");
    confirm.mockRestore(); writer.write.mockResolvedValueOnce(false);
    expect(await deliver()).toBe(false);
    expect(writer.write.mock.calls.map(call => call[0])).toEqual([43, 43]);
    expect(ledger.get(intent.deduplicationKey)?.state).toBe("confirmed");
    expect(sync).toHaveBeenCalled();
  });
  it("não consulta nem regrava o Mongo após confirmação, mesmo se o aviso for apagado", async () => {
    const { deliver, open, reopen, sync } = setup();
    await deliver(); open.mockClear();
    expect(await deliverNotification(intent, reopen(), open, sync)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("importa o histórico sem gerar novas notificações e sem confundir faixas com mensagens iguais", async () => {
    const { ledger, deliver, writer } = setup();
    ledger.importConfirmed([{ key: "stage-30", id: 42 }]);
    writer.findExisting.mockResolvedValueOnce({ id: 42, precise: false });
    expect(await deliver({ ...intent, deduplicationKey: "stage-7" })).toBe(true);
    expect(ledger.get("stage-7")?.id).toBe(43);
    expect(ledger.get("stage-30")?.state).toBe("confirmed");
  });
  it("recusa alteração de conteúdo de uma reserva pendente", async () => {
    const { deliver, writer } = setup();
    writer.write.mockRejectedValueOnce(new Error("temporary_failure"));
    await expect(deliver()).rejects.toThrow();
    await expect(deliver({ ...intent, document: { ...intent.document, mensagem: "Outro conteúdo" } }))
      .rejects.toMatchObject({ code: "PENDING_CONTENT_MISMATCH" });
    expect(writer.write).toHaveBeenCalledTimes(1);
  });
  it("faz rollback de importações conflitantes sem sobrescrever nem avançar IDs", () => {
    const { ledger } = setup();
    ledger.initialize(10);
    expect(() => ledger.importConfirmed([{ key: "first", id: 20 }, { key: "second", id: 20 }])).toThrow();
    expect(ledger.status()).toEqual({ initialized: true, lastId: 10, pending: 0, confirmed: 0 });
  });
});
