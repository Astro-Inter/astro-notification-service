import { positiveId } from "./config";
import type { Candidate, NotificationIntent, RuleContext, RuleId } from "./types";

export function notificationFor(rule: RuleId, row: Candidate, context: RuleContext): NotificationIntent {
  let stage: string;
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
      title = "Conformidade próxima do vencimento";
      message = `Sua conformidade com a NR ${row.nr_id} vence em ${row.referencia}. Verifique a renovação.`;
      break;
    }
    case "expired-compliance":
      stage = "vencida";
      title = "Conformidade vencida";
      message = `Sua conformidade com a NR ${row.nr_id} venceu em ${row.referencia}. Verifique a renovação.`;
      break;
    case "class-deadlines":
      stage = `prazo_${context.settings.classWarningHours}_horas`;
      title = "Prazo de evento próximo do fim";
      eventId = positiveId(row.evento_id ?? "");
      message = `Você tem uma participação pendente no evento “${row.titulo_evento}”. O prazo termina em ${row.referencia} (horário de São Paulo).`;
      break;
    case "pending-validations":
      stage = `aguardando_${context.settings.validationWaitHours}_horas`;
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
    document: {
      id_usuario: userId, mensagem: message, data_criacao: context.now,
      ...(eventId === undefined ? {} : { id_evento: eventId }), titulo: title,
    },
    deduplicationKey: JSON.stringify([1, rule, workspaceId, userId, row.recurso_id, row.referencia, stage]),
  };
}
