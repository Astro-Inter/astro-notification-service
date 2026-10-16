import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const source = process.argv[2];
if (!source || existsSync(".env")) {
  console.error("Uso: node scripts/import-credentials.mjs <arquivo-origem>. O .env de destino não pode existir.");
  process.exit(1);
}
const values = parseEnv(readFileSync(source, "utf8"));
const keys = ["DATABASE_URL", "MONGODB_URI", "MONGODB_DATABASE", "PG_CA_CERT"];
for (const key of keys.slice(0, 3)) {
  if (!values[key]) throw new Error(`Configuração ausente: ${key}`);
}
// JSON.stringify escapa quebras de linha e aspas sem executar o conteúdo.
const lines = keys.filter(key => values[key]).map(key => `${key}=${JSON.stringify(values[key])}`);
writeFileSync(".env", lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
console.log("Credenciais necessárias importadas para .env (ignorado pelo Git). Valores omitidos.");
