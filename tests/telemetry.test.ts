import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grafanaHeaders, logEvent, withTelemetry } from "../src/shared/telemetry";

const env = { GRAFANA_OTLP_ENDPOINT: "https://collector.grafana.net/otlp",
  GRAFANA_OTLP_HEADERS: "Authorization=Basic%20fixture%3D", APP_ENV: "production" };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("logs OTLP para Grafana", () => {
  it("envia autenticação decodificada, datas precisas, severidade e contexto sem dados extras", async () => {
    await withTelemetry(env, "astro-notification-class-deadlines", { runId: "run-1", rule: "class-deadlines" }, async () => {
      logEvent("error", { event: "execution_failed", code: "TEST_ERROR", mensagem: "não exportar", uri: "credencial" });
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://collector.grafana.net/otlp/v1/logs");
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers.get("authorization")).toBe("Basic fixture=");
    expect(options.headers.get("content-type")).toBe("application/json");
    const resource = JSON.parse(options.body).resourceLogs[0];
    expect(resource.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "astro-notification-class-deadlines" } });
    expect(resource.resource.attributes).toContainEqual({ key: "deployment.environment.name", value: { stringValue: "production" } });
    const record = resource.scopeLogs[0].logRecords[0];
    expect(record).toMatchObject({ severityNumber: 17, severityText: "ERROR" });
    expect(BigInt(record.timeUnixNano) % 1000000n).toBe(0n);
    expect(JSON.parse(record.body.stringValue)).toEqual({ runId: "run-1", rule: "class-deadlines", event: "execution_failed", code: "TEST_ERROR" });
    expect(options.body).not.toContain("fixture=");
    expect(options.body).not.toContain("não exportar");
    expect(options.body).not.toContain("credencial");
  });
  it("mantém contextos separados para execuções concorrentes e espera o envio", async () => {
    let delivered = 0;
    fetcher.mockImplementation(async () => { await Promise.resolve(); delivered++; return new Response("{}", { status: 200 }); });
    await Promise.all(["a", "b"].map(runId => withTelemetry(env, `worker-${runId}`, { runId }, async () => {
      logEvent("info", { event: "started" });
      await Promise.resolve();
      logEvent("info", { event: "execution_finished" });
      return runId;
    })));
    expect(delivered).toBe(2);
    for (const [, options] of fetcher.mock.calls) {
      const resource = JSON.parse(options.body).resourceLogs[0];
      const service = resource.resource.attributes.find((a: { key: string }) => a.key === "service.name").value.stringValue;
      expect(resource.scopeLogs[0].logRecords.map((r: { body: { stringValue: string } }) => JSON.parse(r.body.stringValue).runId))
        .toEqual([service.slice(-1), service.slice(-1)]);
    }
  });
  it("permite URL completa de logs sem duplicar o caminho", async () => {
    await withTelemetry({ ...env, GRAFANA_OTLP_ENDPOINT: env.GRAFANA_OTLP_ENDPOINT + "/v1/logs" }, "worker", {}, async () => {
      logEvent("info", { event: "execution_finished" });
    });
    expect(fetcher.mock.calls[0]![0]).toBe("https://collector.grafana.net/otlp/v1/logs");
  });
  it("não faz requisições sem configuração ou sem registros", async () => {
    expect(await withTelemetry({}, "worker", {}, async () => { logEvent("info", { event: "skipped" }); return 42; })).toBe(42);
    await withTelemetry(env, "worker", {}, async () => {});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["http://collector.grafana.net/otlp", "https://example.com/otlp", "https://user:secret@collector.grafana.net/otlp",
    "https://collector.grafana.net/otlp?secret=1"])("recusa destino inseguro: %s", async endpoint => {
    await withTelemetry({ ...env, GRAFANA_OTLP_ENDPOINT: endpoint }, "worker", {}, async () => {
      logEvent("info", { event: "execution_finished" });
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: "telemetry_unavailable", service: "worker" }));
  });
  it("rejeita headers malformados e injeção por quebra de linha", () => {
    for (const value of ["missing", "=value", "Authorization=Basic%0D%0Ainjected", "Authorization=%invalid"]) {
      expect(() => grafanaHeaders(value)).toThrow();
    }
  });
  it("mantém o resultado e o erro de negócio quando a exportação falha", async () => {
    fetcher.mockRejectedValue(new Error("falha com credencial privada"));
    expect(await withTelemetry(env, "worker", {}, async () => { logEvent("info", { event: "execution_finished" }); return "saved"; })).toBe("saved");
    const original = new Error("business failure");
    await expect(withTelemetry(env, "worker", {}, async () => { logEvent("error", { event: "execution_failed" }); throw original; }))
      .rejects.toBe(original);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("credencial privada");
  });
  it.each([401, 429, 503])("registra status %s sem expor resposta ou credenciais", async status => {
    fetcher.mockResolvedValue(new Response("credencial privada do provedor", { status }));
    await withTelemetry(env, "worker", {}, async () => { logEvent("info", { event: "execution_finished" }); });
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: "telemetry_export_failed", service: "worker", httpStatus: status }));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("telemetry_export_succeeded"));
  });
  it("detecta rejeição parcial mesmo com HTTP 200 e contador em string", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ partialSuccess: { rejectedLogRecords: "1", errorMessage: "private details" } }), { status: 200 }));
    await withTelemetry(env, "worker", {}, async () => { logEvent("info", { event: "execution_finished" }); });
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: "telemetry_export_partial", service: "worker" }));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private details");
  });
});
