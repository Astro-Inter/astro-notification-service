import { describe, expect, it } from "vitest";
import { postgresOptions } from "../src/shared/postgres";

describe("conexão PostgreSQL", () => {
  it("usa Hyperdrive quando presente", () => {
    const options = postgresOptions({ HYPERDRIVE: { connectionString: "postgresql://binding" } as Hyperdrive,
      DATABASE_URL: "postgresql://ignored" });
    expect(options.connectionString).toBe("postgresql://binding");
  });
  it("exige TLS verificado em conexão direta remota", () => {
    expect(() => postgresOptions({ DATABASE_URL: "postgresql://user:pass@example.com/db?sslmode=disable" })).toThrow("TLS");
    const options = postgresOptions({ DATABASE_URL: "postgresql://user:pass@example.com/db?sslmode=require", PG_CA_CERT: "a\\nb" });
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca: "a\nb" });
    expect(options.connectionString).not.toContain("sslmode");
  });
  it("permite banco local sem TLS quando explicitamente configurado", () => {
    expect(postgresOptions({ DATABASE_URL: "postgresql://localhost/db?sslmode=disable" }).ssl).toBe(false);
  });
});
