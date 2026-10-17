import { AsyncLocalStorage } from "node:async_hooks";

export interface GrafanaEnv {
  GRAFANA_OTLP_ENDPOINT?: string;
  GRAFANA_OTLP_HEADERS?: string;
  APP_ENV?: string;
}

type Fields = Record<string, unknown>;
type Level = "info" | "error";
interface RecordEntry { timestamp: number; level: Level; fields: Fields }
interface Scope { fields: Fields; records: RecordEntry[] }
const scopes = new AsyncLocalStorage<Scope>();
const allowedFields = ["event", "rule", "runId", "status", "reason", "code", "dryRun", "candidates",
  "inserted", "duplicates", "batches", "durationMs", "scheduledTime", "outcomes"];
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (milliseconds: number) => (BigInt(milliseconds) * 1000000n).toString();

export function grafanaHeaders(value: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const item of value.split(",").filter(part => part.trim())) {
    const equals = item.indexOf("=");
    if (equals <= 0) throw new Error("Invalid telemetry headers");
    const name = item.slice(0, equals).trim();
    const decoded = decodeURIComponent(item.slice(equals + 1).trim());
    if (!/^[a-zA-Z0-9-]+$/.test(name) || /[\r\n]/.test(decoded)) throw new Error("Invalid telemetry headers");
    if (name.toLowerCase() === "content-type") continue;
    headers.set(name, decoded);
  }
  return headers;
}

export function logEvent(level: Level, fields: Fields): void {
  const scope = scopes.getStore();
  const combined = { ...scope?.fields, ...fields };
  // Somente dados operacionais produzidos pelo serviço; nunca exportar objetos Error.
  const safe = Object.fromEntries(allowedFields.filter(key => combined[key] !== undefined)
    .map(key => [key, combined[key]]));
  console[level === "error" ? "error" : "log"](JSON.stringify(safe));
  if (scope) {
    scope.records.push({ timestamp: Date.now(), level, fields: safe });
    if (scope.records.length > 32) scope.records.shift();
  }
}

async function flush(env: GrafanaEnv, service: string, records: RecordEntry[]): Promise<void> {
  if ((!env.GRAFANA_OTLP_ENDPOINT && !env.GRAFANA_OTLP_HEADERS) || !records.length) return;
  let response: Response | undefined;
  try {
    if (!env.GRAFANA_OTLP_ENDPOINT || !env.GRAFANA_OTLP_HEADERS) throw new Error("Incomplete telemetry configuration");
    const base = new URL(env.GRAFANA_OTLP_ENDPOINT);
    if (base.protocol !== "https:" || !base.hostname.endsWith(".grafana.net") || base.port
      || base.username || base.password || base.search || base.hash) throw new Error("Invalid telemetry endpoint");
    const path = base.pathname.replace(/\/$/, "");
    const endpoint = `${base.origin}${path.endsWith("/v1/logs") ? path : path + "/v1/logs"}`;
    const body = { resourceLogs: [{ resource: { attributes: [attribute("service.name", service),
      attribute("service.namespace", "astro"), attribute("deployment.environment.name", env.APP_ENV ?? "development")] },
    scopeLogs: [{ scope: { name: "astro.notifications", version: "1" }, logRecords: records.map(record => ({
      timeUnixNano: nanos(record.timestamp), observedTimeUnixNano: nanos(record.timestamp),
      severityNumber: record.level === "error" ? 17 : 9, severityText: record.level === "error" ? "ERROR" : "INFO",
      body: { stringValue: JSON.stringify(record.fields) },
    })) }] }] };
    response = await fetch(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: grafanaHeaders(env.GRAFANA_OTLP_HEADERS), body: JSON.stringify(body) });
    if (!response.ok) {
      console.warn(JSON.stringify({ event: "telemetry_export_failed", service, httpStatus: response.status }));
      return;
    }
    if (response.status !== 204) {
      const text = await response.text();
      const result = text ? JSON.parse(text) as { partialSuccess?: { rejectedLogRecords?: string | number } } : {};
      if (BigInt(result.partialSuccess?.rejectedLogRecords ?? 0) > 0n) {
        console.warn(JSON.stringify({ event: "telemetry_export_partial", service }));
        return;
      }
    }
    console.log(JSON.stringify({ event: "telemetry_export_succeeded", service, records: records.length, httpStatus: response.status }));
  } catch {
    // Não registrar exceções, headers, URI, resposta do provedor ou credenciais.
    console.warn(JSON.stringify({ event: "telemetry_unavailable", service }));
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

export async function withTelemetry<T>(env: GrafanaEnv, service: string, fields: Fields,
  callback: () => Promise<T>): Promise<T> {
  const scope: Scope = { fields, records: [] };
  return scopes.run(scope, async () => {
    try { return await callback(); }
    finally { await flush(env, service, scope.records); }
  });
}
