import { createWorker } from "../shared/worker";
import { NotificationJob } from "../shared/job-entrypoint";
export class RuleJob extends NotificationJob { readonly rule = "expiring-compliance" as const; }
export default createWorker("expiring-compliance");
