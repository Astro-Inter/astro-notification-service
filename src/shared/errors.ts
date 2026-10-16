export class ServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const code = "code" in error ? String(error.code) : "";
  return /^[A-Z0-9_]{1,48}$/.test(code) ? code : "UNKNOWN";
}
