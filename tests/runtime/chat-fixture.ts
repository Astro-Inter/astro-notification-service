import { ChatPushCoordinator } from "../../src/workers/chat-message-push";
import type { ChatPushEvent } from "../../src/chat/contract";
import type { ChatDelivery } from "../../src/chat/delivery";

export class ChatFixture extends ChatPushCoordinator {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/accept") return new Response(null, { status: await this.accept(await request.json() as ChatPushEvent) });
    if (path === "/lost-alarm") { await this.ctx.storage.deleteAlarm(); return new Response(null, { status: 204 }); }
    if (path === "/expire") {
      const state = await this.ctx.storage.get<ChatDelivery>("state");
      if (!state) return new Response(null, { status: 404 });
      state.event.createdAt = new Date(Date.now() - 86400001).toISOString();
      await this.ctx.storage.put("state", state);
      await this.alarm();
    }
    return Response.json({ state: await this.ctx.storage.get("state"),
      receipt: await this.ctx.storage.get("receipt"), alarm: await this.ctx.storage.getAlarm() });
  }
}
export default {
  fetch(request: Request, env: { FIXTURE: DurableObjectNamespace<ChatFixture> }) {
    return env.FIXTURE.get(env.FIXTURE.idFromName("test")).fetch(request);
  }
};
