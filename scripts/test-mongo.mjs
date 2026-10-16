import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [vitest, "run", "tests/integration/mongo-contract.test.ts"], {
  stdio: "inherit", shell: false, env: { ...process.env, MONGO_CONTRACT_TEST: "true" },
});
process.exitCode = result.status ?? 1;
