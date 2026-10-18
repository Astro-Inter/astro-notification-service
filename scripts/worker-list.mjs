export const workers = [
  "expiring-compliance",
  "expired-compliance",
  "class-deadlines",
  "pending-validations",
  "missing-compliance",
];

export const allWorkers = ["delivery-control", ...workers, "scheduler"];
