export interface ChatPushEvent {
  version: 1;
  messageId: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  workspaceId: string;
  recipientUid: string;
  senderName: string;
  preview: string;
  createdAt: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ["version", "messageId", "conversationId", "senderId", "recipientId", "workspaceId", "recipientUid", "senderName", "preview", "createdAt"];
export function validChatEvent(input: unknown, now = Date.now()): input is ChatPushEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(key => !(key in value))) return false;
  return value.version === 1 && typeof value.messageId === "string" && uuid.test(value.messageId)
    && typeof value.conversationId === "string" && uuid.test(value.conversationId)
    && ["senderId", "recipientId", "workspaceId"].every(key => typeof value[key] === "string" && /^[1-9][0-9]{0,18}$/.test(value[key] as string))
    && value.senderId !== value.recipientId
    && typeof value.recipientUid === "string" && /^[^\s/]{1,128}$/.test(value.recipientUid)
    && typeof value.senderName === "string" && [...value.senderName].length > 0 && [...value.senderName].length <= 80
    && typeof value.preview === "string" && [...value.preview].length > 0 && [...value.preview].length <= 160
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && Date.parse(value.createdAt) <= now + 60000 && Date.parse(value.createdAt) > now - 86400000;
}
export async function authorizedChatRequest(header: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32 || secret.length > 256 || !header || header.length > 512) return false;
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(header)));
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("Bearer " + secret)));
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}
