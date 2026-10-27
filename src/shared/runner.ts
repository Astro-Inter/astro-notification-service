import { observe } from "./diagnostics";
import { booleanSetting, dateInSaoPaulo, positiveId, settingsFromEnv } from "./config";
import { ServiceError } from "./errors";
import { openNotificationStore } from "./control-store";
import { notificationFor } from "./notifications";
import { logEvent } from "./telemetry";
import { openCandidateSource } from "./postgres";
import type { CandidateSource, Env, NotificationStore, RuleContext, RuleId } from "./types";

export interface Dependencies {
  source: (env: Env) => Promise<CandidateSource>;
  store: (env: Env) => Promise<NotificationStore>;
}

export interface RunResult {
  rule: RuleId;
  status: "completed" | "skipped";
  reason?: "disabled" | "applicability_pending";
  dryRun?: boolean;
  candidates: number;
  inserted: number;
  duplicates: number;
  batches: number;
}

const dependencies: Dependencies = { source: openCandidateSource, store: openNotificationStore };

export async function runRule(rule: RuleId, env: Env, now = new Date(), deps = dependencies): Promise<RunResult> {
  const result: RunResult = { rule, status: "skipped", candidates: 0, inserted: 0, duplicates: 0, batches: 0 };
  if (rule === "missing-compliance") return { ...result, reason: "applicability_pending" };
  if (!booleanSetting(env.ENABLED, false)) return { ...result, reason: "disabled" };
  const settings = settingsFromEnv(env);
  const context: RuleContext = { now, today: dateInSaoPaulo(now), settings };
  result.dryRun = settings.dryRun;
  let source: CandidateSource | undefined;
  let store: NotificationStore | undefined;
  try {
    source = await observe("source_connect", "postgresql", () => deps.source(env));
    if (!settings.dryRun) {
      store = await observe("delivery_connect", "notification_control", () => deps.store(env));
      // Sem índice único, nenhuma notificação deve ser escrita.
      await observe("ensure_indexes", "notification_control", () => store!.ensureIndexes());
    }
    let after = "0";
    for (let batch = 0; batch < settings.maxBatches; batch++) {
      const rows = await observe("candidate_page", "postgresql", () => source!.page(rule, context, after));
      if (!rows.length) return { ...result, status: "completed" };
      result.batches++;
      for (const row of rows) {
        if (positiveId(row.cursor) <= Number(after)) throw new ServiceError("PAGINATION_STALLED", "Paginação sem avanço");
        const notification = notificationFor(rule, row, context);
        result.candidates++;
        if (store) {
          if (await observe("deliver_notification", "notification_control", () => store!.insertOnce(notification))) result.inserted++;
          else result.duplicates++;
        }
        after = row.cursor;
      }
      if (rows.length < settings.batchSize) return { ...result, status: "completed" };
    }
    // Não esconder truncamento: falhar permite alertar e ajustar capacidade.
    const remaining = await observe("candidate_page", "postgresql", () => source!.page(rule, context, after));
    if (remaining.length) throw new ServiceError("BATCH_LIMIT_REACHED", "Limite de lotes atingido; ajuste a capacidade da execução");
    return { ...result, status: "completed" };
  } finally {
    const closed = await Promise.allSettled([source?.close(), store?.close()]);
    if (closed.some(item => item.status === "rejected")) {
      logEvent("error", { event: "connection_close_failed", rule });
    }
  }
}
