import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { allWorkers } from "./worker-list.mjs";

const [selection, filename = ".env"] = process.argv.slice(2);
if (selection && !allWorkers.includes(selection)) {
  console.error("Worker desconhecido.");
  process.exit(1);
}
const values = parseEnv(readFileSync(filename, "utf8"));
const secrets = {};
for (const key of ["GRAFANA_OTLP_ENDPOINT", "GRAFANA_OTLP_HEADERS"]) {
  if (!values[key]) throw new Error(`Configuração ausente: ${key}`);
  secrets[key] = values[key];
}
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
for (const worker of selection ? [selection] : allWorkers) {
  const result = spawnSync(process.execPath,
    ["--dns-result-order=ipv4first", wrangler, "secret", "bulk", "--config", `workers/${worker}/wrangler.jsonc`],
    { input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"], shell: false, timeout: 60000 });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
