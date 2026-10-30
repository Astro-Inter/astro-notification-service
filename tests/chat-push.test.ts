import { describe, it, expect, vi } from "vitest";
import { authorizedChatRequest, validChatEvent, type ChatPushEvent } from "../src/chat/contract";
import { handleChatPush } from "../src/chat/handler";
import { deliverChat, type ChatDelivery, type ChatGateway } from "../src/chat/delivery";
const event = (): ChatPushEvent => ({ version: 1, messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  conversationId: "11111111-2222-4333-8444-555555555555", senderId: "1", recipientId: "2", workspaceId: "10",
  recipientUid: "uid-recipient", senderName: "Pessoa autorizada", preview: "Olá!", createdAt: new Date().toISOString() });
const secret = "fixture-chat-secret-with-at-least-32-characters";
const request = (body: unknown = event(), token = secret) => new Request("https://example.test/internal/chat-messages", {
  method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) });
const state = (): ChatDelivery => ({ event: event(), attempts: 0, done: false, devices: {} });
function gateway() {
  return { beginRun: vi.fn(), assertCapacity: vi.fn(), devices: vi.fn().mockResolvedValue([
    { id: "a", token: "fixture-a", version: "v1" }, { id: "b", token: "fixture-b", version: "v2" }]),
    sendChat: vi.fn().mockResolvedValue("accepted"), removeInvalid: vi.fn().mockResolvedValue(undefined) };
}
describe("push de chat por evento", () => {
  it("autentica a API sem aceitar segredo ausente, curto ou diferente", async () => {
    expect(await authorizedChatRequest("Bearer " + secret, secret)).toBe(true);
    expect(await authorizedChatRequest(null, secret)).toBe(false);
    expect(await authorizedChatRequest("Bearer other", secret)).toBe(false);
    expect(await authorizedChatRequest("Bearer short", "short")).toBe(false);
    expect(await authorizedChatRequest("Bearer " + secret, undefined)).toBe(false);
  });
  it("rejeita escopo inválido, payload extra, campos ausentes e eventos antigos", () => {
    expect(validChatEvent(event())).toBe(true);
    for (const invalid of [{ ...event(), recipientId: "1" }, { ...event(), workspaceId: 10 },
      { ...event(), messageId: "invalid" }, { ...event(), recipientUid: "../other" },
      { ...event(), preview: "x".repeat(161) }, { ...event(), createdAt: new Date(Date.now() - 86401000).toISOString() },
      { ...event(), extra: true }, { ...event(), recipientUid: undefined }]) expect(validChatEvent(invalid)).toBe(false);
  });
  it("só confirma HTTP depois do aceite durável e não chama o destino sem autenticação", async () => {
    const accept = vi.fn().mockResolvedValue(202);
    expect((await handleChatPush(request(), { ENABLED: "true", CHAT_PUSH_SECRET: secret }, accept)).status).toBe(202);
    expect(accept).toHaveBeenCalledOnce();
    expect((await handleChatPush(request({}, "wrong"), { ENABLED: "true", CHAT_PUSH_SECRET: secret }, accept)).status).toBe(401);
    expect(accept).toHaveBeenCalledOnce();
    expect((await handleChatPush(request(), { ENABLED: "false", CHAT_PUSH_SECRET: secret }, accept)).status).toBe(503);
    accept.mockRejectedValue(new Error("fixture"));
    expect((await handleChatPush(request(), { ENABLED: "true", CHAT_PUSH_SECRET: secret }, accept)).status).toBe(503);
  });
  it("limita o corpo e impede eventos inválidos antes da fila", async () => {
    const accept = vi.fn();
    expect((await handleChatPush(request({ ...event(), preview: "x".repeat(5000) }),
      { ENABLED: "true", CHAT_PUSH_SECRET: secret }, accept)).status).toBe(413);
    expect((await handleChatPush(request({}), { ENABLED: "true", CHAT_PUSH_SECRET: secret }, accept)).status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });
  it("retoma só dispositivos pendentes e preserva aceite anterior", async () => {
    const delivery = state(), client = gateway(), save = vi.fn().mockResolvedValue(undefined);
    client.sendChat.mockResolvedValueOnce("accepted").mockResolvedValueOnce("retry");
    const now = Date.now();
    expect(await deliverChat(delivery, client, save, now)).toBe(now + 2000);
    expect(delivery.devices["device:a"]?.state).toBe("accepted");
    expect(await deliverChat(delivery, client, save, now + 3000)).toBeNull();
    expect(client.sendChat).toHaveBeenCalledTimes(3);
    expect(client.sendChat.mock.calls[2]?.[1].id).toBe("b");
    expect(delivery.done).toBe(true);
    await deliverChat(delivery, client, save, now + 5000);
    expect(client.sendChat).toHaveBeenCalledTimes(3);
  });
  it("remove token inválido com a versão consultada e respeita Retry-After", async () => {
    const delivery = state(), client = gateway(), now = Date.now();
    client.sendChat.mockResolvedValueOnce("invalid").mockResolvedValueOnce({ retryAfterMs: 120000 });
    expect(await deliverChat(delivery, client, async () => {}, now)).toBe(now + 120000);
    expect(client.removeInvalid).toHaveBeenCalledWith(delivery.event.recipientUid, expect.objectContaining({ id: "a", version: "v1" }));
  });
  it("grava a tentativa antes da chamada e preserva pendência em falha técnica", async () => {
    const delivery = state(), client = gateway();
    client.sendChat.mockImplementation(async () => {
      expect(delivery.devices["device:a"]?.attempts).toBe(1);
      throw new Error("fixture");
    });
    await deliverChat(delivery, client, async () => {}, Date.now());
    expect(delivery.done).toBe(false);
  });
  it("respeita orçamento sem gastar tentativas de dispositivos não enviados", async () => {
    const delivery = state(), client = gateway(), now = Date.now();
    client.assertCapacity.mockImplementation(() => { throw new Error("budget"); });
    expect(await deliverChat(delivery, client, async () => {}, now)).toBe(now + 1000);
    expect(client.sendChat).not.toHaveBeenCalled();
    expect(Object.keys(delivery.devices)).toHaveLength(0);
  });
  it("encerra eventos expirados e destinatários sem dispositivos", async () => {
    const delivery = state(), client = gateway();
    delivery.event.createdAt = new Date(Date.now() - 86500000).toISOString();
    expect(await deliverChat(delivery, client, async () => {})).toBeNull();
    expect(client.devices).not.toHaveBeenCalled();
    const empty = state(); client.devices.mockResolvedValue([]);
    expect(await deliverChat(empty, client, async () => {})).toBeNull();
    expect(empty.done).toBe(true);
  });
});
