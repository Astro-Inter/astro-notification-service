import { describe, expect, it } from "vitest";
import { booleanSetting, dateInSaoPaulo, positiveId, settingsFromEnv } from "../src/shared/config";

describe("configuração e limites", () => {
  it("não exige uma lista de workspaces e começa em simulação", () => {
    expect(settingsFromEnv({})).toMatchObject({
      dryRun: true, expiryWarningDays: [7, 30],
    });
  });
  it("rejeita valores ambíguos, ids sem precisão e lotes excessivos", () => {
    expect(() => booleanSetting("yes", false)).toThrow();
    expect(() => positiveId("9007199254740993")).toThrow();
    expect(() => positiveId("1e2")).toThrow();
    expect(() => settingsFromEnv({ BATCH_SIZE: "501" })).toThrow();
    expect(() => settingsFromEnv({ EXPIRY_WARNING_DAYS: "" })).toThrow();
  });
  it("usa a data de São Paulo na virada do dia UTC", () => {
    expect(dateInSaoPaulo(new Date("2026-10-16T01:00:00Z"))).toBe("2026-10-15");
  });
});
