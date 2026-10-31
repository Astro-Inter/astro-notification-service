import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "../src/shared/config";
import { notificationFor } from "../src/shared/notifications";
import type { Candidate, RuleContext } from "../src/shared/types";

const context: RuleContext = { now: new Date("2026-10-15T12:00:00Z"), today: "2026-10-15",
  settings: settingsFromEnv({}) };
const row: Candidate = { cursor: "10", workspace_id: "1", usuario_id: "2", recurso_id: "10",
  referencia: "2026-10-22", nr_id: 10, dias_restantes: 7 };

describe("contrato e identidade das notificações", () => {
  it("preserva os campos consumidos pela API e a identidade em reexecuções", () => {
    const first = notificationFor("expiring-compliance", row, context);
    const repeated = notificationFor("expiring-compliance", { ...row, dias_restantes: 6 },
      { ...context, now: new Date("2026-10-16T12:00:00Z") });
    expect(first.document).toMatchObject({ usuario_id: 2, data_criacao: context.now,
      titulo: "Conformidade próxima do vencimento" });
    expect(first.document.mensagem).toContain("NR 10");
    expect(repeated.deduplicationKey).toBe(first.deduplicationKey);
    expect(Object.keys(first.document).sort()).toEqual(["data_criacao", "mensagem", "titulo", "usuario_id"]);
  });
  it("distingue as faixas de antecedência, vencimento e renovação", () => {
    const at30 = notificationFor("expiring-compliance", { ...row, dias_restantes: 30 }, context);
    const at7 = notificationFor("expiring-compliance", row, context);
    const expired = notificationFor("expired-compliance", row, context);
    expect(expired.document.titulo).toBe("Conformidade vencida");
    expect(expired.document).not.toHaveProperty("evento_id");
    const renewed = notificationFor("expiring-compliance", { ...row, referencia: "2027-10-22" }, context);
    expect(new Set([at30, at7, expired, renewed].map(n => n.deduplicationKey)).size).toBe(4);
  });
  it("distingue workspaces na chave e recusa a regra ainda sem aplicabilidade", () => {
    const first = notificationFor("expired-compliance", row, context);
    const other = notificationFor("expired-compliance", { ...row, workspace_id: "3" }, context);
    expect(other.document).not.toHaveProperty("workspace_id");
    expect(other.deduplicationKey).not.toBe(first.deduplicationKey);
    expect(() => notificationFor("missing-compliance", row, context)).toThrow("Aplicabilidade");
  });
  it.each([
    ["class-deadlines", "Prazo de evento próximo do fim"],
    ["pending-validations", "Conclusão aguardando avaliação"],
  ] as const)("inclui título e ID do evento em %s sem confundir o recurso de origem", (rule, title) => {
    const notification = notificationFor(rule, { ...row, evento_id: "42", titulo_evento: "Treinamento" }, context);
    expect(notification.document).toMatchObject({ titulo: title, evento_id: 42 });
    expect(Object.keys(notification.document).sort()).toEqual(["data_criacao", "evento_id", "mensagem", "titulo", "usuario_id"]);
    expect(JSON.parse(notification.deduplicationKey)[4]).toBe("10");
    expect(notification.document.mensagem).toContain("Treinamento");
    const renamed = notificationFor(rule, { ...row, evento_id: "42", titulo_evento: "Título atualizado" }, context);
    expect(renamed.deduplicationKey).toBe(notification.deduplicationKey);
  });
  it.each(["class-deadlines", "pending-validations"] as const)("recusa ID de evento ausente, inválido ou impreciso em %s", rule => {
    for (const eventId of [undefined, "0", "inválido", "9007199254740992"]) {
      expect(() => notificationFor(rule, { ...row, ...(eventId === undefined ? {} : { evento_id: eventId }), titulo_evento: "Treinamento" }, context))
        .toThrow("Identificador");
    }
  });
});
