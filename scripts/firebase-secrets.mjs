import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const env = parseEnv(readFileSync(process.argv[2] ?? ".env", "utf8"));
const keys = ["FIREBASE_PROJECT_ID", "FIREBASE_CREDENTIALS_BASE64"];
if (keys.some(key => !env[key])) throw new Error("Configure os dois secrets Firebase");
const account = JSON.parse(Buffer.from(env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf8"));
if (account.project_id !== env.FIREBASE_PROJECT_ID || !account.private_key || !account.client_email) throw new Error("Credenciais Firebase incompatíveis");
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const result = spawnSync(process.execPath, ["--dns-result-order=ipv4first", wrangler, "secret", "bulk", "--config", "workers/pending-events-push/wrangler.jsonc"],
  { input: JSON.stringify(Object.fromEntries(keys.map(key => [key, env[key]]))), stdio: ["pipe", "inherit", "inherit"], timeout: 60000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
process.exitCode = result.status ?? 1;
