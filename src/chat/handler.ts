import { authorizedChatRequest, validChatEvent, type ChatPushEvent } from "./contract";
export interface ChatIngressEnv { CHAT_PUSH_SECRET?: string; ENABLED?: string }
export async function handleChatPush(request: Request, env: ChatIngressEnv, accept: (event: ChatPushEvent) => Promise<number>): Promise<Response> {
  if (new URL(request.url).pathname !== "/internal/chat-messages") return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!await authorizedChatRequest(request.headers.get("authorization"), env.CHAT_PUSH_SECRET)) return new Response("Unauthorized", { status: 401 });
  if (env.ENABLED !== "true") return new Response("Disabled", { status: 503 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response("Unsupported type", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) return new Response("Invalid body", { status: 400 });
  let raw = "";
  const decoder = new TextDecoder();
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 4096) { await reader.cancel(); return new Response("Too large", { status: 413 }); }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();
  let event: unknown;
  try { event = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (!validChatEvent(event)) return new Response("Invalid event", { status: 400 });
  try { return new Response(null, { status: await accept(event) }); }
  catch { return new Response("Unavailable", { status: 503 }); }
}
