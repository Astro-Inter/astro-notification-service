import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Client } from "pg";
import { MongoClient } from "mongodb";

// Somente leitura. O arquivo de origem nunca é impresso ou copiado.
const filename = process.argv[2] ?? ".env";
const env = parseEnv(readFileSync(filename, "utf8"));
const expected = {
  usuario: ["id_usuario", "cargo_id", "unidade_id", "tipo", "status"],
  cargo: ["id_cargo", "workspace_id", "ativo"],
  unidade: ["id_unidade", "workspace_id", "ativo"],
  nr_catalogo: ["codigo_nr", "revogada"],
  conformidade: ["id_conformidade", "usuario_id", "nr_id", "aplicavel", "data_validade"],
  evento: ["id_evento", "gestor_id", "titulo", "status"],
  turma: ["id_turma", "evento_id", "data_termino"],
  turma_funcionario: ["id_turma_funcionario", "turma_id", "usuario_id"],
  conclusao_evento: ["id_conclusao_evento", "turma_funcionario_id", "status", "data_conclusao", "data_validacao"],
};

let failed = false;
const url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
const localPlaintext = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  && url.searchParams.get("sslmode") === "disable";
for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url?.searchParams.delete(key);
const pg = new Client({ connectionString: url?.toString(),
  ssl: localPlaintext ? false : { rejectUnauthorized: true,
    ...(env.PG_CA_CERT ? { ca: env.PG_CA_CERT.replace(/\\n/g, "\n") } : {}) },
  connectionTimeoutMillis: 10000, query_timeout: 15000 });
try {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL ausente");
  await pg.connect();
  await pg.query("BEGIN READ ONLY");
  const { rows } = await pg.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [Object.keys(expected)]);
  const missing = Object.entries(expected).flatMap(([table, columns]) =>
    columns.filter(column => !rows.some(row => row.table_name === table && row.column_name === column))
      .map(column => `${table}.${column}`));
  console.log(JSON.stringify({ postgresql: missing.length ? "schema_incomplete" : "ok", missing }));
  if (missing.length) failed = true;
  await pg.query("ROLLBACK");
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ postgresql: "failed", code: error.code ?? error.name }));
} finally {
  await pg.end().catch(() => {});
}

let mongo;
try {
  if (!env.MONGODB_URI || !env.MONGODB_DATABASE) throw new Error("Configuração MongoDB ausente");
  mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 1 });
  await mongo.connect();
  const db = mongo.db(env.MONGODB_DATABASE);
  await db.command({ ping: 1 });
  const collections = await db.listCollections({ name: "notificacoes" }, { nameOnly: true }).toArray();
  console.log(JSON.stringify({ mongodb: "ok", notificationsCollectionExists: collections.length === 1 }));
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ mongodb: "failed", code: error.code ?? error.name }));
} finally {
  await mongo?.close();
}
process.exitCode = failed ? 1 : 0;
