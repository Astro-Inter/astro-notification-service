import type { RuleQuery } from "../rules/queries";

// Mesmas situações da Home: envio ainda não realizado/rejeitado ou validação pendente.
// O gestor também acompanha qualquer pendência dos participantes de seus eventos.
export function pendingRecipientsQuery(after: string, limit: number, userId?: string): RuleQuery {
  return { text: `SELECT u.id_usuario::text AS user_id, u.firebase_uid AS uid
    FROM public.usuario u
    JOIN public.unidade un ON un.id_unidade = u.unidade_id
    JOIN public.cargo cargo ON cargo.id_cargo = u.cargo_id AND cargo.workspace_id = un.workspace_id
    WHERE u.id_usuario > $1::bigint AND u.status = 'ATIVO'
      AND u.tipo IN ('COLABORADOR', 'GESTOR', 'GESTOR_WORKSPACE')
      AND un.ativo IS TRUE AND cargo.ativo IS TRUE AND NULLIF(BTRIM(u.firebase_uid), '') IS NOT NULL
      ${userId === undefined ? "" : "AND u.id_usuario = $3::bigint"}
      AND (
        EXISTS (
          SELECT 1 FROM public.turma_colaborador tf
          JOIN public.turma t ON t.id_turma = tf.turma_id
          JOIN public.evento e ON e.id_evento = t.evento_id
          JOIN public.usuario gestor ON gestor.id_usuario = e.gestor_id AND gestor.status = 'ATIVO'
          JOIN public.unidade ug ON ug.id_unidade = gestor.unidade_id AND ug.workspace_id = un.workspace_id AND ug.ativo IS TRUE
          LEFT JOIN public.conclusao_evento ce ON ce.turma_colaborador_id = tf.id_turma_colaborador
          WHERE tf.usuario_id = u.id_usuario AND e.status = 'ATIVO'
            AND (ce.id_conclusao_evento IS NULL OR ce.status = 'REJEITADO'
              OR (ce.status = 'PENDENTE' AND ce.data_conclusao IS NULL))
        ) OR (
          u.tipo IN ('GESTOR', 'GESTOR_WORKSPACE') AND EXISTS (
            SELECT 1 FROM public.evento e
            JOIN public.turma t ON t.evento_id = e.id_evento
            JOIN public.turma_colaborador tf ON tf.turma_id = t.id_turma
            JOIN public.usuario participante ON participante.id_usuario = tf.usuario_id
              AND participante.status = 'ATIVO' AND participante.tipo IN ('COLABORADOR','GESTOR')
            JOIN public.unidade up ON up.id_unidade = participante.unidade_id AND up.workspace_id = un.workspace_id AND up.ativo IS TRUE
            JOIN public.cargo cp ON cp.id_cargo = participante.cargo_id AND cp.workspace_id = un.workspace_id AND cp.ativo IS TRUE
            LEFT JOIN public.conclusao_evento ce ON ce.turma_colaborador_id = tf.id_turma_colaborador
            WHERE e.gestor_id = u.id_usuario AND e.status <> 'CANCELADO' AND (
              (ce.status = 'PENDENTE' AND ce.data_conclusao IS NOT NULL AND ce.data_validacao IS NULL)
              OR (e.status = 'ATIVO' AND (ce.id_conclusao_evento IS NULL OR ce.status = 'REJEITADO'
                OR (ce.status = 'PENDENTE' AND ce.data_conclusao IS NULL)))
            )
          )
        )
      ) ORDER BY u.id_usuario LIMIT $2::integer`, values: [after, limit, ...(userId === undefined ? [] : [userId])] };
}
