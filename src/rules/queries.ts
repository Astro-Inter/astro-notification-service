import type { RuleContext, RuleId } from "../shared/types";

export interface RuleQuery { text: string; values: unknown[] }

// Mesma precedência da vw_conformidades, sem exigir que a view esteja instalada.
const compliance = `WITH selecionadas AS (
  SELECT DISTINCT ON (usuario_id, nr_id)
    id_conformidade, usuario_id, nr_id, aplicavel, data_validade
  FROM public.conformidade
  ORDER BY usuario_id, nr_id, aplicavel DESC, data_validade DESC NULLS LAST, id_conformidade DESC
)
SELECT cf.id_conformidade::text AS cursor, un.workspace_id::text AS workspace_id,
  u.id_usuario::text AS usuario_id, cf.id_conformidade::text AS recurso_id,
  to_char(cf.data_validade, 'YYYY-MM-DD') AS referencia, cf.nr_id,
  (cf.data_validade - $2::date) AS dias_restantes
FROM selecionadas cf
JOIN public.usuario u ON u.id_usuario = cf.usuario_id
JOIN public.unidade un ON un.id_unidade = u.unidade_id
JOIN public.cargo c ON c.id_cargo = u.cargo_id AND c.workspace_id = un.workspace_id
JOIN public.nr_catalogo nr ON nr.codigo_nr = cf.nr_id
WHERE cf.id_conformidade > $1::bigint
  AND u.tipo = 'COLABORADOR' AND u.status = 'ATIVO'
  AND un.ativo IS TRUE AND c.ativo IS TRUE
  AND cf.aplicavel IS TRUE AND nr.revogada IS FALSE
  AND cf.data_validade IS NOT NULL`;

const participationJoins = `
JOIN public.turma t ON t.id_turma = tf.turma_id
JOIN public.evento e ON e.id_evento = t.evento_id
JOIN public.usuario u ON u.id_usuario = tf.usuario_id
JOIN public.unidade un ON un.id_unidade = u.unidade_id
JOIN public.cargo c ON c.id_cargo = u.cargo_id AND c.workspace_id = un.workspace_id
JOIN public.usuario gestor ON gestor.id_usuario = e.gestor_id
JOIN public.unidade un_gestor ON un_gestor.id_unidade = gestor.unidade_id
JOIN public.cargo cargo_gestor ON cargo_gestor.id_cargo = gestor.cargo_id
  AND cargo_gestor.workspace_id = un_gestor.workspace_id`;

const participationEligibility = `
  AND un_gestor.workspace_id = un.workspace_id
  AND u.tipo IN ('COLABORADOR', 'GESTOR') AND u.status = 'ATIVO'
  AND gestor.tipo IN ('GESTOR', 'GESTOR_WORKSPACE') AND gestor.status = 'ATIVO'
  AND un.ativo IS TRUE AND c.ativo IS TRUE
  AND un_gestor.ativo IS TRUE AND cargo_gestor.ativo IS TRUE`;

export function candidateQuery(rule: RuleId, context: RuleContext, after: string): RuleQuery {
  const { settings } = context;
  switch (rule) {
    case "expiring-compliance":
      return { text: `${compliance}
        AND cf.data_validade >= $2::date AND cf.data_validade <= $2::date + $3::integer
        ORDER BY cf.id_conformidade LIMIT $4::integer`,
        values: [after, context.today, Math.max(...settings.expiryWarningDays), settings.batchSize] };
    case "expired-compliance":
      return { text: `${compliance} AND cf.data_validade < $2::date
        ORDER BY cf.id_conformidade LIMIT $3::integer`,
        values: [after, context.today, settings.batchSize] };
    case "class-deadlines":
      return {
        text: `SELECT tf.id_turma_funcionario::text AS cursor, un.workspace_id::text AS workspace_id,
          u.id_usuario::text AS usuario_id, tf.id_turma_funcionario::text AS recurso_id,
          to_char(t.data_termino, 'YYYY-MM-DD HH24:MI:SS') AS referencia, e.titulo AS titulo_evento,
          e.id_evento::text AS evento_id
        FROM public.turma_funcionario tf ${participationJoins}
        LEFT JOIN public.conclusao_evento ce ON ce.turma_funcionario_id = tf.id_turma_funcionario
        WHERE tf.id_turma_funcionario > $1::bigint ${participationEligibility}
          AND e.status = 'ATIVO'
          AND t.data_termino >= ($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')
          AND t.data_termino <= ($2::timestamptz AT TIME ZONE 'America/Sao_Paulo') + ($3::integer * interval '1 hour')
          AND (ce.id_conclusao_evento IS NULL OR ce.status = 'REJEITADO'
            OR (ce.status = 'PENDENTE' AND ce.data_conclusao IS NULL))
        ORDER BY tf.id_turma_funcionario LIMIT $4::integer`,
        values: [after, context.now.toISOString(), settings.classWarningHours, settings.batchSize],
      };
    case "pending-validations":
      return {
        text: `SELECT ce.id_conclusao_evento::text AS cursor, un.workspace_id::text AS workspace_id,
          gestor.id_usuario::text AS usuario_id, ce.id_conclusao_evento::text AS recurso_id,
          to_char(ce.data_conclusao, 'YYYY-MM-DD HH24:MI:SS') AS referencia, e.titulo AS titulo_evento,
          e.id_evento::text AS evento_id
        FROM public.conclusao_evento ce
        JOIN public.turma_funcionario tf ON tf.id_turma_funcionario = ce.turma_funcionario_id
        ${participationJoins}
        WHERE ce.id_conclusao_evento > $1::bigint ${participationEligibility}
          AND e.status <> 'CANCELADO'
          AND ce.status = 'PENDENTE' AND ce.data_conclusao IS NOT NULL AND ce.data_validacao IS NULL
          AND ce.data_conclusao <= ($2::timestamptz AT TIME ZONE 'America/Sao_Paulo') - ($3::integer * interval '1 hour')
        ORDER BY ce.id_conclusao_evento LIMIT $4::integer`,
        values: [after, context.now.toISOString(), settings.validationWaitHours, settings.batchSize],
      };
    case "missing-compliance":
      throw new Error("Aplicabilidade de obrigações sem registro ainda não definida");
  }
}
