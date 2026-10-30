import { DurableObject } from "cloudflare:workers";
import { FirebaseGateway, type FirebaseEnv } from "../push/firebase";
import { validChatEvent, type ChatPushEvent } from "../chat/contract";
import { handleChatPush } from "../chat/handler";
import { deliverChat, type ChatDelivery } from "../chat/delivery";

interface Env extends FirebaseEnv {
  CHAT_PUSH_SECRET?: string;
  ENABLED?: string;
  CHAT_PUSHES: DurableObjectNamespace<ChatPushCoordinator>;
}
export class ChatPushCoordinator extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly gateway: FirebaseGateway;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.gateway = new FirebaseGateway(env); }
  accept(event: ChatPushEvent) {
    const operation = this.queue.then(async () => {
      if (this.env.ENABLED !== "true" || !validChatEvent(event)) return 503;
      const previous = await this.ctx.storage.get<{ messageId: string; fingerprint: string; done: boolean }>("receipt");
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(JSON.stringify(event))))).map(value => value.toString(16).padStart(2, "0")).join("");
      if (previous) {
        if (previous.fingerprint !== fingerprint) return 409;
        if (await this.ctx.storage.get("state") && await this.ctx.storage.getAlarm() === null)
          await this.ctx.storage.setAlarm(Date.now() + 1);
        return 202;
      }
      const state: ChatDelivery = { event, devices: Object.create(null) as ChatDelivery["devices"], attempts: 0, done: false };
      await this.ctx.storage.put({ state, receipt: { messageId: event.messageId, fingerprint, done: false } });
      await this.ctx.storage.setAlarm(Date.now() + 1);
      return 202;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  alarm() {
    const operation = this.queue.then(async () => {
      const state = await this.ctx.storage.get<ChatDelivery>("state");
      if (!state) { await this.ctx.storage.deleteAll(); return; }
      if (Date.now() >= Date.parse(state.event.createdAt) + 86400000) {
        await this.ctx.storage.delete("state");
        await this.ctx.storage.setAlarm(Date.now() + 7 * 86400000);
        return;
      }
      if (this.env.ENABLED !== "true") {
        await this.ctx.storage.setAlarm(Math.min(Date.now() + 60000, Date.parse(state.event.createdAt) + 86400000));
        return;
      }
      const next = await deliverChat(state, this.gateway, () => this.ctx.storage.put("state", state));
      if (next !== null) { await this.ctx.storage.setAlarm(next); return; }
      await this.ctx.storage.delete("state");
      await this.ctx.storage.setAlarm(Date.now() + 7 * 86400000);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleChatPush(request, env, event => {
      const actor = env.CHAT_PUSHES.get(env.CHAT_PUSHES.idFromName(event.messageId));
      return actor.accept(event);
    });
  }
};
