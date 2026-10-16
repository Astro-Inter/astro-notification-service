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
  PG_CA_CERT?: string;
}

export interface Settings {
  dryRun: boolean;
  workspaceIds: number[];
  expiryWarningDays: number[];
  classWarningHours: number;
  validationWaitHours: number;
  batchSize: number;
  maxBatches: number;
}

export interface RuleContext {
  now: Date;
  today: string;
  settings: Settings;
}

export interface Candidate {
  cursor: string;
  workspace_id: string;
  usuario_id: string;
  recurso_id: string;
  referencia: string;
  nr_id?: number;
  dias_restantes?: number;
  titulo_evento?: string;
}

export interface NotificationDocument {
  id_usuario: number;
  mensagem: string;
  data_criacao: Date;
  workspace_id: number;
  tipo: RuleId;
  recurso: { tipo: string; id: string };
  chave_deduplicacao: string;
  regra_versao: number;
}

export interface CandidateSource {
  page(rule: RuleId, context: RuleContext, after: string): Promise<Candidate[]>;
  close(): Promise<void>;
}

export interface NotificationStore {
  ensureIndexes(): Promise<void>;
  insertOnce(document: NotificationDocument): Promise<boolean>;
  close(): Promise<void>;
}
