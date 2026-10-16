import { createWorker } from "../shared/worker";
import { NotificationJob } from "../shared/job-entrypoint";
export class RuleJob extends NotificationJob { readonly rule = "pending-validations" as const; }
export default createWorker("pending-validations");
