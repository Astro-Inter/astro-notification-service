import { beforeAll, describe, expect, it, vi } from "vitest";
import { FirebaseGateway } from "../src/push/firebase";
let credentials: string;
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer;
  credentials = btoa(JSON.stringify({ project_id: "demo-astro-push", client_email: "fixture@demo-astro-push.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----` }));
});
function gateway(replies: Response[]) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => replies.shift()!);
  return { request, client: new FirebaseGateway({ FIREBASE_PROJECT_ID: "demo-astro-push", FIREBASE_CREDENTIALS_BASE64: credentials }, request) };
}
const access = () => Response.json({ access_token: "fixture-oauth-only", expires_in: 3600 });
const device = { id: "installation", token: "fixture-only-token", version: "2026-10-24T12:00:00Z" };
describe("integração oficial Firestore/FCM HTTP v1 sem expor credenciais", () => {
  it("usa o fetch global sem vincular seu this ao gateway", async () => {
    const request = vi.fn(function (this: unknown) {
      expect(this).not.toBeInstanceOf(FirebaseGateway);
      return Promise.resolve(request.mock.calls.length === 1 ? access() : Response.json({}));
    });
    vi.stubGlobal("fetch", request);
    try {
      const client = new FirebaseGateway({ FIREBASE_PROJECT_ID: "demo-astro-push", FIREBASE_CREDENTIALS_BASE64: credentials });
      expect(await client.devices("uid")).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("diagnostica autenticação sem expor a resposta ou credenciais", async () => {
    const { client } = gateway([Response.json({ error_description: "sensitive-provider-detail" }, { status: 400 })]);
    await expect(client.devices("uid")).rejects.toMatchObject({ code: "FIREBASE_AUTH_HTTP_400", message: "Firebase recusou a autenticação" });
  });
  it("assina JWT RS256 correto com escopos mínimos e reutiliza o access token", async () => {
    const { client, request } = gateway([access(), Response.json({}), Response.json({})]);
    expect(await client.devices("uid")).toEqual([]); await client.devices("uid");
    expect(request).toHaveBeenCalledTimes(3);
    const body = request.mock.calls[0]![1]!.body as URLSearchParams;
    const assertion = body.get("assertion")!;
    const [header, payload, signature] = assertion.split(".");
    const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(header!))).alg).toBe("RS256");
    expect(JSON.parse(new TextDecoder().decode(decode(payload!)))).toMatchObject({ aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore" });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode(signature!), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });
  it("consulta múltiplos dispositivos por UID com paginação sem buscar outros usuários", async () => {
    const { client, request } = gateway([access(), Response.json({ documents: [{ name: "devices/a", updateTime: "v1", fields: { token: { stringValue: "a" } } }], nextPageToken: "next" }),
      Response.json({ documents: [{ name: "devices/b", updateTime: "v2", fields: { token: { stringValue: "b" } } }] })]);
    expect((await client.devices("uid/encoded")).map(row => row.id)).toEqual(["a", "b"]);
    expect(String(request.mock.calls[1]![0])).toContain("fcm_tokens/uid%2Fencoded/devices");
    expect(String(request.mock.calls[2]![0])).toContain("pageToken=next");
  });
  it("envia apenas data-only genérico, com UID, ciclo e ID numérico para filtragem no Android", async () => {
    const { client, request } = gateway([access(), Response.json({ name: "accepted" })]);
    expect(await client.send("uid", 123, 11, device)).toBe("accepted");
    const body = JSON.parse(request.mock.calls[1]![1]!.body as string);
    expect(body.message).not.toHaveProperty("notification");
    expect(body.message.data).toMatchObject({ type: "pending_events", uid: "uid", cycle_id: "123", notification_id: "11" });
    expect(body.message.android).toMatchObject({ ttl: "86400s", priority: "HIGH" });
  });
  it("só invalida tokens quando o erro é específico do FCM, nunca em erro genérico do payload", async () => {
    const { client } = gateway([access(), Response.json({ error: { details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }, { status: 404 }),
      Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 })]);
    expect(await client.send("uid", 123, 11, device)).toBe("invalid");
    await expect(client.send("uid", 123, 11, device)).rejects.toMatchObject({ code: "FCM_PAYLOAD" });
  });
  it("remove token inválido com precondição de versão para preservar token renovado em paralelo", async () => {
    const { client, request } = gateway([access(), new Response(null, { status: 412 })]);
    await client.removeInvalid("uid", device);
    expect(String(request.mock.calls[1]![0])).toContain("currentDocument.updateTime=2026-10-24T12%3A00%3A00Z");
    expect(request.mock.calls[1]![1]!.method).toBe("DELETE");
  });
  it("mantém token em falha temporária ou falta de permissão", async () => {
    const { client } = gateway([access(), Response.json({}, { status: 503 }), Response.json({}, { status: 403 })]);
    expect(await client.send("uid", 123, 11, device)).toBe("retry");
    await expect(client.send("uid", 123, 11, device)).rejects.toMatchObject({ code: "FCM_PERMISSION" });
  });
  it("respeita Retry-After fornecido pelo FCM", async () => {
    const { client } = gateway([access(), Response.json({}, { status: 429, headers: { "retry-after": "7200" } })]);
    expect(await client.send("uid", 123, 11, device)).toEqual({ retryAfterMs: 7200000 });
  });
});
