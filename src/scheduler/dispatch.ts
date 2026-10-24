import { booleanSetting } from "../shared/config";
import { safeErrorCode } from "../shared/errors";
import type { GrafanaEnv } from "../shared/telemetry";

export interface JobBinding {
  run(scheduledTime?: number): Promise<unknown>;
  status(): Promise<unknown>;
}

export interface SchedulerEnv extends GrafanaEnv {
  ENABLED?: string;
  DAILY_HOUR_UTC?: string;
  SUMMARY: JobBinding;
  CLASSES: JobBinding;
  EXPIRING: JobBinding;
  EXPIRED: JobBinding;
  VALIDATIONS: JobBinding;
  PUSH: JobBinding;
}

export type BindingName = "SUMMARY" | "CLASSES" | "EXPIRING" | "EXPIRED" | "VALIDATIONS" | "PUSH";
export const bindings: BindingName[] = ["SUMMARY", "CLASSES", "EXPIRING", "EXPIRED", "VALIDATIONS", "PUSH"];

export function dueJobs(time: Date, dailyHour = "11"): BindingName[] {
  if (!Number.isFinite(time.getTime())) throw new Error("Horário agendado inválido");
  if (!/^([0-9]|1[0-9]|2[0-3])$/.test(dailyHour)) throw new Error("DAILY_HOUR_UTC deve estar entre 0 e 23");
  const due: BindingName[] = ["SUMMARY", "CLASSES"];
  if (time.getUTCHours() === Number(dailyHour)) due.push("EXPIRING", "EXPIRED", "VALIDATIONS");
  due.push("PUSH");
  return due;
}

export async function dispatchDue(env: SchedulerEnv, time: Date) {
  if (!booleanSetting(env.ENABLED, false)) return { status: "skipped" as const, outcomes: [] };
  const due = dueJobs(time, env.DAILY_HOUR_UTC);
  // Uma falha não impede o disparo dos demais Workers. Aguardar todas as execuções.
  const results = await Promise.allSettled(due.map(async job => job === "PUSH" ? env[job].run(time.getTime()) : env[job].run()));
  const outcomes = results.map((result, index) => {
    const job = due[index]!;
    if (result.status === "rejected") return { job, status: "failed", code: safeErrorCode(result.reason) };
    const value = result.value as { status?: unknown } | null | undefined;
    const jobStatus = typeof value?.status === "string" && /^[a-z_]{1,32}$/.test(value.status)
      ? value.status : "returned";
    return { job, status: "fulfilled", jobStatus };
  });
  return { status: outcomes.some(outcome => outcome.status === "failed") ? "failed" as const : "completed" as const, outcomes };
}
