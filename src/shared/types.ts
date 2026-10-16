export const ruleIds = [
  "expiring-compliance",
  "expired-compliance",
  "class-deadlines",
  "pending-validations",
  "missing-compliance",
] as const;

export type RuleId = typeof ruleIds[number];

export interface Env {
  ENABLED?: string;
  DRY_RUN?: string;
  WORKSPACE_IDS?: string;
  DATABASE_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  MONGODB_URI?: string;
  MONGODB_DATABASE?: string;
  EXPIRY_WARNING_DAYS?: string;
  CLASS_WARNING_HOURS?: string;
  VALIDATION_WAIT_HOURS?: string;
  BATCH_SIZE?: string;
  MAX_BATCHES?: string;
}
