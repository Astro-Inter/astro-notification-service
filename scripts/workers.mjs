import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workers } from "./worker-list.mjs";

const [action, selection, ...extra] = process.argv.slice(2);
if (!["dev", "build", "deploy"].includes(action) ||
    (selection && !workers.includes(selection)) ||
    (action === "dev" && !selection)) {
  console.error(`Uso: npm run <dev|build|deploy> -- <${workers.join("|")}>`);
  console.error("build e deploy sem seleção processam todos os Workers.");
  process.exit(1);
}

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
for (const worker of selection ? [selection] : workers) {
  let configPath = `workers/${worker}/wrangler.jsonc`;
  if (action === "dev" && !extra.includes("--remote")) {
    // Banco local direto: não usar o pool de produção no desenvolvimento local.
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.hyperdrive;
    delete config.$schema;
    config.main = resolve(`src/workers/${worker}.ts`);
    configPath = `.wrangler/local/${worker}.json`;
    mkdirSync(".wrangler/local", { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  const args = [wrangler, action === "build" ? "deploy" : action,
    "--config", configPath];
  if (action === "dev") {
    args.push("--test-scheduled");
    if (existsSync(".env")) args.push("--env-file", resolve(".env"));
    args.push(...extra);
  } else if (extra.length) {
    console.error("Opções extras são aceitas apenas em dev.");
    process.exit(1);
  }
  if (action === "build") args.push("--dry-run", "--outdir", `../../dist/${worker}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
