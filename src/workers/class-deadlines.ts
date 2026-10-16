import { createWorker } from "../shared/worker";
import { NotificationJob } from "../shared/job-entrypoint";
export class RuleJob extends NotificationJob { readonly rule = "class-deadlines" as const; }
export default createWorker("class-deadlines");
