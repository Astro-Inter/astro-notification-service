import type { Env, Settings } from "./types";

export function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Configuração booleana deve ser true ou false");
}

export function positiveId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Identificador inválido");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error("Identificador excede a precisão numérica suportada");
  return id;
}

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = value === undefined ? fallback : positiveId(value);
  if (parsed > max) throw new Error("Configuração numérica fora do limite");
  return parsed;
}

export function settingsFromEnv(env: Env): Settings {
  const expiryWarningDays = [...new Set((env.EXPIRY_WARNING_DAYS ?? "30,7").split(",")
    .map(value => boundedInteger(value.trim(), 30, 365)))].sort((a, b) => a - b);
  return {
    dryRun: booleanSetting(env.DRY_RUN, true), expiryWarningDays,
    classWarningHours: boundedInteger(env.CLASS_WARNING_HOURS, 24, 720),
    validationWaitHours: boundedInteger(env.VALIDATION_WAIT_HOURS, 48, 2160),
    batchSize: boundedInteger(env.BATCH_SIZE, 100, 500),
    maxBatches: boundedInteger(env.MAX_BATCHES, 100, 1000),
  };
}

export function dateInSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
