import { Client, type ClientConfig } from "pg";
import { candidateQuery } from "../rules/queries";
import type { Candidate, CandidateSource, Env } from "./types";

export function postgresOptions(env: Env): ClientConfig {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error("Configure o binding HYPERDRIVE ou DATABASE_URL");
  const options: ClientConfig = { connectionString, connectionTimeoutMillis: 10000,
    query_timeout: 15000, statement_timeout: 10000, application_name: "astro-notification-service" };
  if (!env.HYPERDRIVE) {
    const url = new URL(connectionString);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const plaintext = url.searchParams.get("sslmode") === "disable";
    if (plaintext && !local) throw new Error("PostgreSQL remoto exige TLS");
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(key);
    options.connectionString = url.toString();
    options.ssl = plaintext && local ? false : {
      rejectUnauthorized: true,
      ...(env.PG_CA_CERT ? { ca: env.PG_CA_CERT.replace(/\\n/g, "\n") } : {}),
    };
  }
  return options;
}

export async function openCandidateSource(env: Env): Promise<CandidateSource> {
  const client = new Client(postgresOptions(env));
  // Não registrar mensagens do driver: podem incluir host, usuário ou SQL.
  client.on("error", () => console.error(JSON.stringify({ event: "postgres_connection_error" })));
  try {
    await client.connect();
    return {
      async page(rule, context, after) {
        const query = candidateQuery(rule, context, after);
        await client.query("BEGIN READ ONLY");
        try {
          const { rows } = await client.query<Candidate>(query.text, query.values);
          await client.query("COMMIT");
          return rows;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
      close: () => client.end(),
    };
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}
