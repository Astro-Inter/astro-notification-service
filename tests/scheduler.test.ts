import { describe, expect, it, vi } from "vitest";
import { bindings, dispatchDue, dueJobs, type SchedulerEnv } from "../src/scheduler/dispatch";

function fixture() {
  return { ENABLED: "true", DAILY_HOUR_UTC: "11", ...Object.fromEntries(bindings.map(job => [job, {
    run: vi.fn().mockResolvedValue({ status: "completed" }), status: vi.fn().mockResolvedValue({ enabled: false }),
  }])) } as unknown as SchedulerEnv;
}

describe("disparador compartilhado", () => {
  it("mantém resumos e turmas horários e concentra as regras diárias às 08h de São Paulo", () => {
    expect(dueJobs(new Date("2026-10-16T10:00:00Z"))).toEqual(["SUMMARY", "CLASSES", "PUSH"]);
    expect(dueJobs(new Date("2026-10-16T11:00:00Z"))).toEqual(bindings);
    expect(dueJobs(new Date("2026-10-17T00:00:00Z"))).toEqual(["SUMMARY", "CLASSES", "PUSH"]);
  });
  it("recusa horários inválidos antes de disparar Workers", () => {
    expect(() => dueJobs(new Date("invalid"))).toThrow();
    expect(() => dueJobs(new Date(), "24")).toThrow();
  });
  it("uma falha não suprime os demais disparos e o resultado conserva a falha", async () => {
    const env = fixture();
    vi.mocked(env.SUMMARY.run).mockRejectedValue({ code: "PROVIDER_UNAVAILABLE" });
    const result = await dispatchDue(env, new Date("2026-10-16T11:00:00Z"));
    expect(result.status).toBe("failed");
    expect(result.outcomes[0]).toEqual({ job: "SUMMARY", status: "failed", code: "PROVIDER_UNAVAILABLE" });
    for (const job of bindings) expect(env[job].run).toHaveBeenCalledOnce();
  });
  it("fora do horário diário não chama as regras diárias", async () => {
    const env = fixture();
    await dispatchDue(env, new Date("2026-10-16T12:00:00Z"));
    expect(env.SUMMARY.run).toHaveBeenCalledOnce();
    expect(env.CLASSES.run).toHaveBeenCalledOnce();
    expect(env.EXPIRING.run).not.toHaveBeenCalled();
    expect(env.EXPIRED.run).not.toHaveBeenCalled();
    expect(env.VALIDATIONS.run).not.toHaveBeenCalled();
  });
  it("pausa o disparador sem alterar as configurações dos serviços", async () => {
    const env = fixture();
    expect((await dispatchDue({ ...env, ENABLED: "false" }, new Date())).status).toBe("skipped");
    for (const job of bindings) expect(env[job].run).not.toHaveBeenCalled();
  });
});
