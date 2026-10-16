import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const workers = [
  "expiring-compliance",
  "expired-compliance",
  "class-deadlines",
  "pending-validations",
  "missing-compliance",
];

const [action, selection] = process.argv.slice(2);
if (!["dev", "build", "deploy"].includes(action) ||
    (selection && !workers.includes(selection)) ||
    (action === "dev" && !selection)) {
  console.error(`Uso: npm run <dev|build|deploy> -- <${workers.join("|")}>`);
  console.error("build e deploy sem seleção processam todos os Workers.");
  process.exit(1);
}

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
for (const worker of selection ? [selection] : workers) {
  const args = [wrangler, action === "build" ? "deploy" : action,
    "--config", `workers/${worker}/wrangler.jsonc`];
  if (action === "build") args.push("--dry-run", "--outdir", `../../dist/${worker}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
