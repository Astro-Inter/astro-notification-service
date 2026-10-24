import { ServiceError } from "../shared/errors";

export interface FirebaseEnv { FIREBASE_PROJECT_ID?: string; FIREBASE_CREDENTIALS_BASE64?: string }
export interface Device { id: string; token: string; version: string }
export type SendResult = "accepted" | "invalid" | "retry" | { retryAfterMs: number };
export const PUSH_TITLE = "Eventos pendentes";
export const PUSH_BODY = "Você tem eventos pendentes. Abra o Astro para conferir.";
const scopes = "https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export class FirebaseGateway {
  private cached?: { value: string; until: number };
  constructor(private readonly env: FirebaseEnv, private readonly request: typeof fetch = fetch) {}
  private project(): string {
    if (!this.env.FIREBASE_PROJECT_ID || !/^[a-z][a-z0-9-]{4,62}$/.test(this.env.FIREBASE_PROJECT_ID)) throw new ServiceError("FIREBASE_CONFIG", "Projeto Firebase ausente ou inválido");
    return this.env.FIREBASE_PROJECT_ID;
  }
  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    try {
      const account = JSON.parse(atob(this.env.FIREBASE_CREDENTIALS_BASE64 ?? "")) as { project_id: string; client_email: string; private_key: string };
      if (account.project_id !== this.project() || !account.client_email?.endsWith(".gserviceaccount.com") || !account.private_key) throw new Error();
      const der = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, "")), char => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: scopes, aud: tokenEndpoint, iat: now, exp: now + 3600 })}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
      const response = await this.request(tokenEndpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(new Uint8Array(signature))}` }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const result = await response.json() as { access_token?: string; expires_in?: number };
      if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error();
      this.cached = { value: result.access_token, until: Date.now() + (Math.min(result.expires_in!, 3600) - 60) * 1000 };
      return this.cached.value;
    } catch { throw new ServiceError("FIREBASE_AUTH", "Não foi possível autenticar no Firebase"); }
  }
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.request(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json", Authorization: `Bearer ${await this.accessToken()}` } });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("FIREBASE_UNAVAILABLE", "Firebase indisponível");
    }
  }
  private documents(uid: string) {
    return `https://firestore.googleapis.com/v1/projects/${this.project()}/databases/(default)/documents/fcm_tokens/${encodeURIComponent(uid)}/devices`;
  }
  async devices(uid: string): Promise<Device[]> {
    const devices: Device[] = [];
    let page = "";
    do {
      const url = new URL(this.documents(uid)); url.searchParams.set("pageSize", "100");
      if (page) url.searchParams.set("pageToken", page);
      const response = await this.call(url.toString());
      if (!response.ok) { await response.body?.cancel(); throw new ServiceError("FIRESTORE_READ", "Não foi possível consultar dispositivos"); }
      const result = await response.json() as { documents?: { name: string; updateTime: string; fields?: { token?: { stringValue?: string } } }[]; nextPageToken?: string };
      for (const row of result.documents ?? []) {
        const token = row.fields?.token?.stringValue;
        if (token && row.updateTime) devices.push({ id: row.name.split("/").at(-1)!, token, version: row.updateTime });
      }
      if (devices.length > 500) throw new ServiceError("DEVICE_LIMIT", "Limite de dispositivos por conta excedido");
      page = result.nextPageToken ?? "";
    } while (page);
    return devices;
  }
  async removeInvalid(uid: string, device: Device): Promise<void> {
    const url = `${this.documents(uid)}/${encodeURIComponent(device.id)}?currentDocument.updateTime=${encodeURIComponent(device.version)}`;
    const response = await this.call(url, { method: "DELETE" });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404 && response.status !== 412) throw new ServiceError("FIRESTORE_DELETE", "Não foi possível remover token inválido");
  }
  async send(uid: string, cycle: number, id: number, device: Device): Promise<SendResult> {
    const response = await this.call(`https://fcm.googleapis.com/v1/projects/${this.project()}/messages:send`, {
      method: "POST", body: JSON.stringify({ message: { token: device.token,
        data: { type: "pending_events", uid, cycle_id: String(cycle), notification_id: String(id), title: PUSH_TITLE, body: PUSH_BODY },
        android: { priority: "HIGH", ttl: "86400s", collapseKey: "astro_pending_events" } } }),
    });
    if (response.ok) { await response.body?.cancel(); return "accepted"; }
    const result = await response.json().catch(() => ({})) as { error?: { details?: { "@type"?: string; errorCode?: string }[] } };
    const fcm = result.error?.details?.find(detail => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError")?.errorCode;
    if (fcm === "UNREGISTERED" || fcm === "INVALID_ARGUMENT") return "invalid";
    if (response.status === 401 || response.status === 403) throw new ServiceError("FCM_PERMISSION", "Verifique as permissões do serviço Firebase");
    if (response.status === 429 || response.status >= 500) {
      const header = response.headers.get("retry-after");
      const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 0;
      return Number.isFinite(delay) && delay > 0 ? { retryAfterMs: delay } : "retry";
    }
    throw new ServiceError("FCM_PAYLOAD", "FCM recusou a mensagem");
  }
}
