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
    expect(first).toMatchObject({ id_usuario: 2, workspace_id: 1, data_criacao: context.now, regra_versao: 1,
      titulo: "Conformidade próxima do vencimento" });
    expect(first.mensagem).toContain("NR 10");
    expect(repeated.chave_deduplicacao).toBe(first.chave_deduplicacao);
    expect(first).not.toHaveProperty("_id");
    expect(first).not.toHaveProperty("idevento");
  });
  it("distingue as faixas de antecedência, vencimento e renovação", () => {
    const at30 = notificationFor("expiring-compliance", { ...row, dias_restantes: 30 }, context);
    const at7 = notificationFor("expiring-compliance", row, context);
    const expired = notificationFor("expired-compliance", row, context);
    expect(expired.titulo).toBe("Conformidade vencida");
    expect(expired).not.toHaveProperty("idevento");
    const renewed = notificationFor("expiring-compliance", { ...row, referencia: "2027-10-22" }, context);
    expect(new Set([at30, at7, expired, renewed].map(n => n.chave_deduplicacao)).size).toBe(4);
  });
  it("distingue workspaces na chave e recusa a regra ainda sem aplicabilidade", () => {
    const first = notificationFor("expired-compliance", row, context);
    const other = notificationFor("expired-compliance", { ...row, workspace_id: "3" }, context);
    expect(other.workspace_id).toBe(3);
    expect(other.chave_deduplicacao).not.toBe(first.chave_deduplicacao);
    expect(() => notificationFor("missing-compliance", row, context)).toThrow("Aplicabilidade");
  });
  it.each([
    ["class-deadlines", "Prazo de evento próximo do fim"],
    ["pending-validations", "Conclusão aguardando avaliação"],
  ] as const)("inclui título e ID do evento em %s sem confundir o recurso de origem", (rule, title) => {
    const notification = notificationFor(rule, { ...row, evento_id: "42", titulo_evento: "Treinamento" }, context);
    expect(notification).toMatchObject({ titulo: title, idevento: 42, recurso: { id: "10" } });
    expect(notification.mensagem).toContain("Treinamento");
    const renamed = notificationFor(rule, { ...row, evento_id: "42", titulo_evento: "Título atualizado" }, context);
    expect(renamed.chave_deduplicacao).toBe(notification.chave_deduplicacao);
  });
  it.each(["class-deadlines", "pending-validations"] as const)("recusa ID de evento ausente, inválido ou impreciso em %s", rule => {
    for (const eventId of [undefined, "0", "inválido", "9007199254740992"]) {
      expect(() => notificationFor(rule, { ...row, ...(eventId === undefined ? {} : { evento_id: eventId }), titulo_evento: "Treinamento" }, context))
        .toThrow("Identificador");
    }
  });
});
