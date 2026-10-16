import { createWorker } from "../shared/worker";
import { NotificationJob } from "../shared/job-entrypoint";
export class RuleJob extends NotificationJob { readonly rule = "missing-compliance" as const; }
export default createWorker("missing-compliance");
