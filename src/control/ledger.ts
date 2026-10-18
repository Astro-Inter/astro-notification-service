import { ServiceError } from "../shared/errors";
import { notificationIdFloor } from "../shared/notification-id";

export interface Receipt { key: string; id: number | null }
export interface Reservation { id: number | null; state: "pending" | "confirmed"; fingerprint: string; createdAt: string }

export class DeliveryLedger {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS sequence (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value INTEGER NOT NULL, ready INTEGER NOT NULL);
      INSERT OR IGNORE INTO sequence VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS deliveries (
        business_key TEXT PRIMARY KEY, notification_id INTEGER UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed')),
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  get(key: string): Reservation | undefined {
    return this.storage.sql.exec<{ id: number | null; state: "pending" | "confirmed"; fingerprint: string; createdAt: string }>(
      `SELECT notification_id AS id, state, fingerprint, created_at AS createdAt FROM deliveries WHERE business_key = ?`, key).toArray()[0];
  }
  owner(id: number): string | undefined {
    return this.storage.sql.exec<{ business_key: string }>("SELECT business_key FROM deliveries WHERE notification_id = ?", id).toArray()[0]?.business_key;
  }
  initialized(): boolean {
    return this.storage.sql.exec<{ ready: number }>("SELECT ready FROM sequence WHERE singleton = 1").one().ready === 1;
  }
  initialize(floor: number): void {
    if (!Number.isSafeInteger(floor) || floor < 0 || floor >= notificationIdFloor) throw new ServiceError("INVALID_ID_FLOOR", "Piso numérico inválido");
    this.storage.sql.exec("UPDATE sequence SET value = MAX(value, ?), ready = 1 WHERE singleton = 1", floor);
  }
  reserve(key: string, fingerprint: string, createdAt: string): Reservation {
    return this.storage.transactionSync(() => {
      const previous = this.get(key);
      if (previous) return previous;
      const sequence = this.storage.sql.exec<{ value: number; ready: number }>("SELECT value, ready FROM sequence WHERE singleton = 1").one();
      if (!sequence.ready) throw new ServiceError("CONTROL_NOT_INITIALIZED", "Controle não inicializado");
      const id = sequence.value + 1;
      if (!Number.isSafeInteger(id) || id >= notificationIdFloor) throw new ServiceError("NOTIFICATION_ID_EXHAUSTED", "Faixa de IDs esgotada");
      this.storage.sql.exec("UPDATE sequence SET value = ? WHERE singleton = 1", id);
      this.storage.sql.exec("INSERT INTO deliveries VALUES (?, ?, 'pending', ?, ?)", key, id, fingerprint, createdAt);
      return { id, state: "pending", fingerprint, createdAt };
    });
  }
  confirm(key: string): void {
    if (!this.get(key)) throw new ServiceError("RESERVATION_MISSING", "Reserva ausente");
    this.storage.sql.exec("UPDATE deliveries SET state = 'confirmed' WHERE business_key = ?", key);
  }
  importConfirmed(receipts: Receipt[]): void {
    if (receipts.length > 100) throw new ServiceError("IMPORT_LIMIT", "Importe até 100 registros por chamada");
    this.storage.transactionSync(() => {
      for (const receipt of receipts) {
        if (typeof receipt.key !== "string" || !receipt.key || receipt.key.length > 4096
          || (receipt.id !== null && (!Number.isSafeInteger(receipt.id) || receipt.id < 1))) {
          throw new ServiceError("INVALID_RECEIPT", "Registro de entrega inválido");
        }
        const existing = this.get(receipt.key);
        if (existing) {
          if (existing.id !== receipt.id || existing.state !== "confirmed") throw new ServiceError("IMPORT_CONFLICT", "Importação incompatível");
          continue;
        }
        if (receipt.id !== null && this.owner(receipt.id)) throw new ServiceError("IMPORT_ID_CONFLICT", "ID já associado a outra chave");
        this.storage.sql.exec("INSERT INTO deliveries VALUES (?, ?, 'confirmed', '', '')", receipt.key, receipt.id);
        if (receipt.id !== null && receipt.id < notificationIdFloor) {
          this.storage.sql.exec("UPDATE sequence SET value = MAX(value, ?) WHERE singleton = 1", receipt.id);
        }
      }
    });
  }
  status() {
    const sequence = this.storage.sql.exec<{ value: number; ready: number }>("SELECT value, ready FROM sequence WHERE singleton = 1").one();
    const counts = this.storage.sql.exec<{ state: string; total: number }>("SELECT state, COUNT(*) AS total FROM deliveries GROUP BY state").toArray();
    return { initialized: sequence.ready === 1, lastId: sequence.value,
      pending: counts.find(row => row.state === "pending")?.total ?? 0,
      confirmed: counts.find(row => row.state === "confirmed")?.total ?? 0 };
  }
}
