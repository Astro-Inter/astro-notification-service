import { afterEach, describe, expect, it, vi } from "vitest";
import { PushLedger, PUSH_INTERVAL } from "../src/push/ledger";
import { runPendingPush, type PushEnv, type PushSource } from "../src/push/runner";
import { sqliteLedger } from "./helpers/ledger";
import { ServiceError } from "../src/shared/errors";
const fixtures: ReturnType<typeof sqliteLedger>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const start = Date.parse("2026-01-30T11:00:00Z");
const hour = 3600000;
function fixture() {
  const sql = sqliteLedger(); fixtures.push(sql);
  const ledger = new PushLedger(sql.storage);
  const user = { user_id: "2", uid: "firebase-user" };
  const source: PushSource = { page: vi.fn().mockResolvedValue([user]), current: vi.fn().mockResolvedValue(user), close: vi.fn() };
  const dependencies = { source: vi.fn().mockResolvedValue(source), sync: vi.fn().mockResolvedValue(undefined), gateway: {
    devices: vi.fn().mockResolvedValue([{ id: "phone", token: "fixture-only", version: "v1" }]),
    send: vi.fn().mockResolvedValue("accepted"), removeInvalid: vi.fn(),
  } };
  const env = { PUSH_CONTROL: { deliverWithReceipt: vi.fn().mockResolvedValue({ inserted: true, id: 11 }) } } as unknown as PushEnv;
  return { ledger, source, dependencies, env, user, reopen: () => new PushLedger(sql.storage), run: (at = start) => runPendingPush(env, ledger, at, dependencies) };
}
describe("somente lembrete genérico de eventos pendentes a cada 72 horas", () => {
  it("rechecagem operacional preserva o ciclo e os dispositivos já entregues", async () => {
    const f = fixture(); await f.run();
    expect(f.ledger.recheck(f.user)).toBe(true);
    expect(f.ledger.status()).toMatchObject({ cycle: start, pendingRecipients: 1 });
    expect((await f.run()).sent).toBe(0);
    expect(f.dependencies.gateway.send).toHaveBeenCalledTimes(1);
    expect(f.ledger.recheck({ ...f.user, uid: "another-identity" })).toBe(false);
    expect(f.ledger.status()).toMatchObject({ cycle: start, pendingRecipients: 0 });
  });
  it("continua após atingir orçamento externo sem perder destinatários nem repetir os concluídos", async () => {
    const f = fixture();
    const second = { user_id: "3", uid: "second-user" };
    vi.mocked(f.source.page).mockResolvedValue([f.user, second]);
    vi.mocked(f.source.current).mockImplementation(async id => id === "2" ? f.user : second);
    f.dependencies.gateway.devices.mockResolvedValueOnce([]).mockRejectedValueOnce(new ServiceError("FIREBASE_REQUEST_BUDGET", "Continuar"));
    expect(await f.run()).toMatchObject({ status: "deferred", reason: "request_budget", missingTokens: 1, failures: 0 });
    expect(f.ledger.status().pendingRecipients).toBe(1);
    f.dependencies.gateway.devices.mockClear().mockResolvedValue([]);
    expect(await f.run(start + hour)).toMatchObject({ status: "completed", missingTokens: 1, failures: 0 });
    expect(f.dependencies.gateway.devices).toHaveBeenCalledExactlyOnceWith(second.uid);
    expect(f.ledger.status().pendingRecipients).toBe(0);
  });
  it("envia uma vez por dispositivo no ciclo e não consulta bancos nas horas intermediárias", async () => {
    const f = fixture(); const result = await f.run();
    expect(result.sent).toBe(1);
    expect(f.env.PUSH_CONTROL.deliverWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ document: {
      id_usuario: 2, titulo: "Eventos pendentes", mensagem: "Você tem eventos pendentes. Abra o Astro para conferir.", data_criacao: new Date(start),
    } }));
    f.dependencies.source.mockClear();
    expect(await f.run(start + hour)).toMatchObject({ status: "skipped", reason: "not_due" });
    expect(f.dependencies.source).not.toHaveBeenCalled();
    expect(f.dependencies.gateway.send).toHaveBeenCalledTimes(1);
  });
  it("respeita exatamente 72h inclusive na virada do mês e após reabrir SQLite", async () => {
    const f = fixture(); await f.run();
    expect((await runPendingPush(f.env, f.reopen(), start + PUSH_INTERVAL - hour, f.dependencies)).status).toBe("skipped");
    expect((await runPendingPush(f.env, f.reopen(), start + PUSH_INTERVAL, f.dependencies)).sent).toBe(1);
    expect(f.dependencies.gateway.send).toHaveBeenCalledTimes(2);
  });
  it("não grava no Mongo nem chama FCM quando não há tokens", async () => {
    const f = fixture(); f.dependencies.gateway.devices.mockResolvedValue([]);
    expect((await f.run()).missingTokens).toBe(1);
    expect(f.env.PUSH_CONTROL.deliverWithReceipt).not.toHaveBeenCalled();
    expect(f.dependencies.gateway.send).not.toHaveBeenCalled();
  });
  it("ignora um disparo antigo que chega depois de avançar ao próximo ciclo", async () => {
    const f = fixture(); await f.run(); await f.run(start + PUSH_INTERVAL);
    f.dependencies.source.mockClear();
    expect(await f.run(start + hour)).toMatchObject({ status: "skipped", reason: "stale_schedule" });
    expect(f.dependencies.source).not.toHaveBeenCalled();
  });
  it("retoma falha parcial sem reenviar ao dispositivo aceito e revalida a pendência", async () => {
    const f = fixture();
    f.dependencies.gateway.devices.mockResolvedValue([{ id: "a", token: "a", version: "v1" }, { id: "b", token: "b", version: "v1" }]);
    f.dependencies.gateway.send.mockResolvedValueOnce("accepted").mockResolvedValueOnce("retry").mockResolvedValueOnce("accepted");
    expect((await f.run()).failures).toBe(1);
    expect((await f.run(start + hour)).sent).toBe(1);
    expect(f.dependencies.gateway.send.mock.calls.map(call => call[3].id)).toEqual(["a", "b", "b"]);
    expect(f.source.current).toHaveBeenCalledTimes(2);
  });
  it("abandona retry se o evento foi resolvido ou se a identidade mudou", async () => {
    const f = fixture(); f.dependencies.gateway.send.mockResolvedValueOnce("retry"); await f.run();
    vi.mocked(f.source.current).mockResolvedValueOnce({ ...f.user, uid: "another-account" });
    await f.run(start + hour); expect(f.dependencies.gateway.send).toHaveBeenCalledTimes(1);
    expect(f.ledger.status().pendingRecipients).toBe(0);
  });
  it("remove somente o token permanentemente inválido e conserva os demais dispositivos", async () => {
    const f = fixture(); f.dependencies.gateway.send.mockResolvedValueOnce("invalid");
    expect((await f.run()).invalid).toBe(1);
    expect(f.dependencies.gateway.removeInvalid).toHaveBeenCalledWith(f.user.uid, { id: "phone", token: "fixture-only", version: "v1" });
  });
  it("não ignora o Retry-After do provedor entre retomadas do mesmo ciclo", async () => {
    const f = fixture(); f.dependencies.gateway.send.mockResolvedValueOnce({ retryAfterMs: 3 * hour });
    await f.run(); await f.run(start + hour); await f.run(start + 2 * hour);
    expect(f.dependencies.gateway.send).toHaveBeenCalledTimes(1);
    await f.run(start + 3 * hour); expect(f.dependencies.gateway.send).toHaveBeenCalledTimes(2);
  });
  it("reserva tentativa antes de enviar, aplica backoff e limita a cinco tentativas", () => {
    const f = fixture(); f.ledger.cycle(start);
    expect(f.ledger.attempt(start, "2", "phone", start)).toBe(true);
    const restored = f.reopen();
    expect(restored.attempt(start, "2", "phone", start)).toBe(false);
    expect(restored.attempt(start, "2", "phone", start + hour)).toBe(true);
    expect(restored.attempt(start, "2", "phone", start + 2 * hour)).toBe(false);
    expect(restored.attempt(start, "2", "phone", start + 3 * hour)).toBe(true);
    expect(restored.attempt(start, "2", "phone", start + 7 * hour)).toBe(true);
    expect(restored.attempt(start, "2", "phone", start + 15 * hour)).toBe(true);
    expect(restored.attempt(start, "2", "phone", start + 40 * hour)).toBe(false);
  });
});
