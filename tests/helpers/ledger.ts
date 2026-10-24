import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DeliveryLedger } from "../../src/control/ledger";

export function sqliteLedger() {
  const database = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec(query: string, ...bindings: SQLInputValue[]) {
      let rows: Record<string, unknown>[];
      if (query.split(";").filter(part => part.trim()).length > 1) { database.exec(query); rows = []; }
      else rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error("row_count"); return rows[0]; } };
    } },
    transactionSync<T>(work: () => T) {
      database.exec("BEGIN");
      try { const result = work(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  } as unknown as Pick<DurableObjectStorage, "sql" | "transactionSync">;
  return { storage, ledger: new DeliveryLedger(storage), reopen: () => new DeliveryLedger(storage), close: () => database.close() };
}
