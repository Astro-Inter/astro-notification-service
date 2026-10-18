import { describe, expect, it } from "vitest";
import { notificationId, notificationIdFloor } from "../src/shared/notification-id";

describe("identidade numérica da notificação", () => {
  it("mantém o mesmo resultado entre versões e reexecuções", async () => {
    expect(await notificationId("example")).toBe(5635227678125934);
    expect(await notificationId("example")).toBe(await notificationId("example"));
  });
  it("separa chaves de negócio e permanece na faixa de inteiros seguros", async () => {
    const ids = await Promise.all(Array.from({ length: 1000 }, (_, index) => notificationId(`stage-${index}`)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => Number.isSafeInteger(id) && id >= notificationIdFloor && id <= Number.MAX_SAFE_INTEGER)).toBe(true);
  });
  it("recusa identidade vazia", async () => {
    await expect(notificationId("")).rejects.toThrow("Identidade");
  });
});
