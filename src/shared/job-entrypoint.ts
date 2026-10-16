import { WorkerEntrypoint } from "cloudflare:workers";
import { executeRule } from "./execution";
import type { Env, RuleId } from "./types";

// Acesso apenas por Service Binding; não adiciona endpoint HTTP de execução.
export abstract class NotificationJob extends WorkerEntrypoint<Env> {
  abstract readonly rule: RuleId;

  async run() { return executeRule(this.rule, this.env); }

  async preview() {
    return executeRule(this.rule, { ...this.env, ENABLED: "true", DRY_RUN: "true" });
  }

  async status() {
    return { service: "astro-notification-service", rule: this.rule,
      enabled: this.env.ENABLED === "true", dryRun: this.env.DRY_RUN !== "false",
      scope: "all_workspaces" };
  }
}
