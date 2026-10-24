import { NotificationCoordinator } from "../../src/workers/delivery-control";
import type { NotificationWriter } from "../../src/control/delivery";
import type { NotificationDocument, NotificationIntent } from "../../src/shared/types";

export class ControlFixture extends NotificationCoordinator {
  protected async openWriter(): Promise<NotificationWriter> {
    return {
      ensureIndexes: async () => {}, maxSequentialId: async () => 0, findExisting: async () => null,
      write: async (id, document) => {
        const key = `fixture:${id}`;
        if (this.ctx.storage.kv.get(key)) return false;
        this.ctx.storage.kv.put(key, { _id: id, ...document });
        if (this.ctx.storage.kv.get("fail_after_write")) {
          this.ctx.storage.kv.delete("fail_after_write");
          throw new Error("Simular resposta perdida após gravar no Mongo");
        }
        return true;
      }, close: async () => {},
    };
  }
  async clearFixtures() {
    for (const [key] of this.ctx.storage.kv.list({ prefix: "fixture:" })) this.ctx.storage.kv.delete(key);
  }
  async failAfterWrite() { this.ctx.storage.kv.put("fail_after_write", true); }
  async documents() { return Array.from(this.ctx.storage.kv.list<NotificationDocument>({ prefix: "fixture:" }), ([, value]) => value); }
  async restart(): Promise<void> { this.ctx.abort("Reiniciar somente o objeto de teste"); }
}

export default {
  async fetch(request: Request, env: { FIXTURE: DurableObjectNamespace<ControlFixture> }) {
    const object = env.FIXTURE.get(env.FIXTURE.idFromName("test"));
    const route = new URL(request.url).pathname;
    try {
      if (route === "/initialize") return Response.json(await object.initialize());
      if (route === "/deliver" || route === "/receipt") {
        const body = await request.json() as NotificationIntent;
        body.document.data_criacao = new Date(body.document.data_criacao);
        return Response.json(route === "/receipt" ? await object.deliverWithReceipt(body) : { inserted: await object.deliver(body) });
      }
      if (route === "/clear") { await object.clearFixtures(); return Response.json({ ok: true }); }
      if (route === "/fail") { await object.failAfterWrite(); return Response.json({ ok: true }); }
      if (route === "/restart") { try { await object.restart(); } catch {} return Response.json({ ok: true }); }
      return Response.json({ status: await object.status(), documents: await object.documents() });
    } catch { return Response.json({ status: "failed" }, { status: 500 }); }
  },
};
