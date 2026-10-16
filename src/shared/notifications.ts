import { positiveId } from "./config";
import type { Candidate, NotificationDocument, RuleContext, RuleId } from "./types";

export function notificationFor(rule: RuleId, row: Candidate, context: RuleContext): NotificationDocument {
  let stage: string;
  let resource: string;
  let message: string;
  let title: string;
  let eventId: number | undefined;
  switch (rule) {
    case "expiring-compliance": {
      const days = row.dias_restantes;
      if (days === undefined || !Number.isInteger(days) || days < 0) throw new Error("Prazo de conformidade inválido");
      const threshold = context.settings.expiryWarningDays.find(value => days <= value);
      if (threshold === undefined) throw new Error("Conformidade fora da janela de aviso");
      stage = `ate_${threshold}_dias`;
      resource = "conformidade";
      title = "Conformidade próxima do vencimento";
      message = `Sua conformidade com a NR ${row.nr_id} vence em ${row.referencia}. Verifique a renovação.`;
      break;
    }
    case "expired-compliance":
      stage = "vencida";
      resource = "conformidade";
      title = "Conformidade vencida";
      message = `Sua conformidade com a NR ${row.nr_id} venceu em ${row.referencia}. Verifique a renovação.`;
      break;
    case "class-deadlines":
      stage = `prazo_${context.settings.classWarningHours}_horas`;
      resource = "turma_funcionario";
      title = "Prazo de evento próximo do fim";
      eventId = positiveId(row.evento_id ?? "");
      message = `Você tem uma participação pendente no evento “${row.titulo_evento}”. O prazo termina em ${row.referencia} (horário de São Paulo).`;
      break;
    case "pending-validations":
      stage = `aguardando_${context.settings.validationWaitHours}_horas`;
      resource = "conclusao_evento";
      title = "Conclusão aguardando avaliação";
      eventId = positiveId(row.evento_id ?? "");
      message = `Há uma conclusão do evento “${row.titulo_evento}” aguardando sua avaliação desde ${row.referencia} (horário de São Paulo).`;
      break;
    case "missing-compliance":
      throw new Error("Aplicabilidade de obrigações sem registro ainda não definida");
  }
  const userId = positiveId(row.usuario_id);
  const workspaceId = positiveId(row.workspace_id);
  positiveId(row.recurso_id);
  return {
    id_usuario: userId, titulo: title, mensagem: message, data_criacao: context.now,
    ...(eventId === undefined ? {} : { idevento: eventId }),
    workspace_id: workspaceId, tipo: rule, recurso: { tipo: resource, id: row.recurso_id },
    chave_deduplicacao: JSON.stringify([1, rule, workspaceId, userId, row.recurso_id, row.referencia, stage]),
    regra_versao: 1,
  };
}
