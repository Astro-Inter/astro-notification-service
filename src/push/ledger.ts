export const PUSH_INTERVAL = 72 * 60 * 60 * 1000;
export type Recipient = { user_id: string; uid: string };
export type Cycle = { id: number; after_id: string; scanned: number };
export class PushLedger {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS push_cycles (id INTEGER PRIMARY KEY, after_id TEXT NOT NULL, scanned INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_recipients (cycle INTEGER NOT NULL, user_id TEXT NOT NULL, uid TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(cycle,user_id));
      CREATE TABLE IF NOT EXISTS push_devices (cycle INTEGER NOT NULL, user_id TEXT NOT NULL, device TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(cycle,user_id,device));`);
  }
  cycle(now: number): Cycle {
    const current = this.storage.sql.exec<Cycle>("SELECT * FROM push_cycles ORDER BY id DESC LIMIT 1").toArray()[0];
    if (current && now < current.id + PUSH_INTERVAL) return current;
    this.storage.sql.exec("INSERT INTO push_cycles VALUES (?, '0', 0)", now);
    return { id: now, after_id: "0", scanned: 0 };
  }
  add(cycle: number, rows: Recipient[], after: string, scanned: boolean) {
    this.storage.transactionSync(() => {
      for (const row of rows) this.storage.sql.exec("INSERT OR IGNORE INTO push_recipients VALUES (?,?,?,0)", cycle, row.user_id, row.uid);
      this.storage.sql.exec("UPDATE push_cycles SET after_id = ?, scanned = ? WHERE id = ?", after, scanned ? 1 : 0, cycle);
    });
  }
  pending(cycle: number): Recipient[] {
    return this.storage.sql.exec<Recipient>("SELECT user_id, uid FROM push_recipients WHERE cycle = ? AND done = 0 ORDER BY CAST(user_id AS INTEGER) LIMIT 1000", cycle).toArray();
  }
  done(cycle: number, user: string) { this.storage.sql.exec("UPDATE push_recipients SET done = 1 WHERE cycle = ? AND user_id = ?", cycle, user); }
  recheck(recipient: Recipient): boolean {
    const cycle = this.status().cycle;
    if (cycle === null) return false;
    // Ação operacional explícita: não avançar o ciclo nem apagar entregas aceitas.
    return this.storage.sql.exec<{ user_id: string }>(`INSERT INTO push_recipients VALUES (?,?,?,0)
      ON CONFLICT(cycle,user_id) DO UPDATE SET done=0 WHERE push_recipients.uid=excluded.uid
      RETURNING user_id`, cycle, recipient.user_id, recipient.uid).toArray().length === 1;
  }
  attempt(cycle: number, user: string, device: string, now: number): boolean {
    const row = this.storage.sql.exec<{ state: string; attempts: number; retry_at: number }>(
      "SELECT * FROM push_devices WHERE cycle = ? AND user_id = ? AND device = ?", cycle, user, device).toArray()[0];
    if (row && (row.state !== "retry" || row.attempts >= 5 || row.retry_at > now)) return false;
    const attempts = (row?.attempts ?? 0) + 1;
    const retry = now + Math.min(24, 2 ** (attempts - 1)) * 3600000;
    this.storage.sql.exec("INSERT INTO push_devices VALUES (?,?,?,'retry',?,?) ON CONFLICT(cycle,user_id,device) DO UPDATE SET attempts=excluded.attempts,retry_at=excluded.retry_at", cycle, user, device, attempts, retry);
    return true;
  }
  result(cycle: number, user: string, device: string, state: "accepted" | "invalid") {
    this.storage.sql.exec("UPDATE push_devices SET state = ? WHERE cycle = ? AND user_id = ? AND device = ?", state, cycle, user, device);
  }
  defer(cycle: number, user: string, device: string, until: number) {
    this.storage.sql.exec("UPDATE push_devices SET retry_at = MAX(retry_at, ?) WHERE cycle = ? AND user_id = ? AND device = ?", until, cycle, user, device);
  }
  retryPending(cycle: number, user: string) {
    return this.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM push_devices WHERE cycle = ? AND user_id = ? AND state = 'retry' AND attempts < 5", cycle, user).one().total > 0;
  }
  status() {
    const cycle = this.storage.sql.exec<Cycle>("SELECT * FROM push_cycles ORDER BY id DESC LIMIT 1").toArray()[0];
    return { cycle: cycle?.id ?? null, nextCycle: cycle ? cycle.id + PUSH_INTERVAL : null,
      pendingRecipients: cycle ? this.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM push_recipients WHERE cycle = ? AND done = 0", cycle.id).one().total : 0 };
  }
}
