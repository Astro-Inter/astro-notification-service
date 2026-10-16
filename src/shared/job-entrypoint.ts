import { WorkerEntrypoint } from "cloudflare:workers";
import { executeRule } from "./execution";
import type { Env, RuleId } from "./types";

// Acesso apenas por Service Binding; não adiciona endpoint HTTP de execução.
export abstract class NotificationJob extends WorkerEntrypoint<Env> {
  abstract readonly rule: RuleId;

  async run() { return executeRule(this.rule, this.env); }

  async status() {
    return { service: "astro-notification-service", rule: this.rule,
      enabled: this.env.ENABLED === "true", dryRun: this.env.DRY_RUN !== "false",
      workspaceConfigured: Boolean(this.env.WORKSPACE_IDS?.trim()) };
  }
}
