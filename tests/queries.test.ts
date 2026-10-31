import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { candidateQuery } from "../src/rules/queries";
import { settingsFromEnv } from "../src/shared/config";
import { notificationFor } from "../src/shared/notifications";
import type { Candidate, RuleContext, RuleId } from "../src/shared/types";

let db: PGlite;
const context: RuleContext = { now: new Date("2026-10-15T15:00:00Z"), today: "2026-10-15",
  settings: settingsFromEnv({ BATCH_SIZE: "2" }) };
async function candidates(rule: RuleId, after = "0", ctx = context) {
  const query = candidateQuery(rule, ctx, after);
  return (await db.query<Candidate>(query.text, query.values)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(new NodeURL("./fixtures/schema.sql", import.meta.url), "utf8"));
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE conclusao_evento, turma_colaborador, turma, evento, conformidade, usuario, cargo, unidade, nr_catalogo;
    INSERT INTO unidade VALUES (1,1,true),(2,2,true),(3,1,false);
    INSERT INTO cargo VALUES (1,1,true),(2,2,true),(3,1,false);
    INSERT INTO usuario VALUES (2,1,1,'COLABORADOR','ATIVO'),(3,1,1,'GESTOR','ATIVO'),
      (4,2,2,'COLABORADOR','ATIVO'),(5,2,2,'GESTOR','ATIVO'),
      (6,1,1,'COLABORADOR','DESATIVADO'),(7,2,1,'COLABORADOR','ATIVO'),
      (8,3,1,'COLABORADOR','ATIVO'),(9,1,3,'COLABORADOR','ATIVO');
    INSERT INTO nr_catalogo VALUES (10,false),(20,true),(30,false),(40,false);
    INSERT INTO evento VALUES (1,3,'Treinamento','ATIVO'),(2,3,'Cancelado','CANCELADO'),
      (3,5,'Outro workspace','ATIVO'),(4,3,'Encerrado','CONCLUIDO');
    INSERT INTO turma VALUES (1,1,'2026-10-16 12:00:00'),(2,2,'2026-10-16 12:00:00'),
      (3,3,'2026-10-16 12:00:00'),(4,4,'2026-10-10 12:00:00');`);
});

describe("consultas executadas em PostgreSQL (PGlite)", () => {
  it("uma renovação vigente suprime o vencimento antigo", async () => {
    await db.exec(`INSERT INTO conformidade VALUES
      (1,2,10,true,'2026-10-14'),(2,2,10,true,'2027-10-15');`);
    expect(await candidates("expired-compliance")).toEqual([]);
    expect(await candidates("expiring-compliance")).toEqual([]);
  });
  it("analisa todos os workspaces preservando aplicabilidade e consistência dos vínculos", async () => {
    await db.exec(`INSERT INTO conformidade VALUES
      (1,2,10,true,'2026-10-14'),(2,2,20,true,'2026-10-14'),(3,2,30,false,'2026-10-14'),
      (4,2,40,true,NULL),(5,4,10,true,'2026-10-14'),(6,6,10,true,'2026-10-14'),
      (7,7,10,true,'2026-10-14'),(8,8,10,true,'2026-10-14'),(9,9,10,true,'2026-10-14');`);
    expect((await candidates("expired-compliance")).map(row => [row.cursor, row.workspace_id])).toEqual([["1", "1"], ["5", "2"]]);
  });
  it("trata hoje como válido, inclui o limite de 30 dias e pagina por id", async () => {
    await db.exec(`INSERT INTO conformidade VALUES
      (1,2,10,true,'2026-10-15'),(2,2,30,true,'2026-11-14'),(3,2,40,true,'2026-11-15');`);
    const rows = await candidates("expiring-compliance");
    expect(rows.map(row => [row.cursor, row.dias_restantes])).toEqual([["1", 0], ["2", 30]]);
    expect(await candidates("expired-compliance")).toEqual([]);
    expect(await candidates("expiring-compliance", "2")).toEqual([]);
  });
  it("mantém a precedência documentada ao escolher o registro vigente", async () => {
    await db.exec(`INSERT INTO conformidade VALUES
      (1,2,10,true,'2026-10-22'),(2,2,10,false,'2027-01-01'),
      (3,2,10,true,'2026-10-22'),(4,2,10,true,NULL);`);
    expect((await candidates("expiring-compliance"))[0]?.cursor).toBe("3");
  });
  it("avisa participação pendente e rejeitada, sem cobrar quem já enviou para análise", async () => {
    await db.exec(`INSERT INTO turma_colaborador VALUES (1,1,2),(2,1,3),(3,1,2);
      INSERT INTO conclusao_evento VALUES
      (1,2,'PENDENTE','2026-10-15 10:00:00',NULL),
      (2,3,'REJEITADO','2026-10-14 10:00:00','2026-10-15 10:00:00');`);
    const rows = await candidates("class-deadlines");
    expect(rows.map(row => [row.cursor, row.evento_id])).toEqual([["1", "1"], ["3", "1"]]);
    expect(rows.map(row => notificationFor("class-deadlines", row, context).document.evento_id)).toEqual([1, 1]);
    expect(await candidates("class-deadlines", "3")).toEqual([]);
  });
  it("exclui eventos cancelados, outros workspaces e prazos encerrados", async () => {
    await db.exec(`INSERT INTO turma_colaborador VALUES (1,2,2),(2,3,2),(3,4,2),(4,1,4),(5,1,6);
      UPDATE turma SET data_termino='2026-10-15 11:59:59' WHERE id_turma=1;`);
    expect(await candidates("class-deadlines")).toEqual([]);
  });
  it("usa o horário de São Paulo e o limite de antecedência exato", async () => {
    await db.exec(`INSERT INTO turma_colaborador VALUES (1,1,2);`);
    expect((await candidates("class-deadlines")).length).toBe(1);
    await db.exec(`UPDATE turma SET data_termino='2026-10-16 12:00:01' WHERE id_turma=1;`);
    expect(await candidates("class-deadlines")).toEqual([]);
  });
  it("encaminha ao gestor responsável apenas envios antigos ainda sem validação", async () => {
    await db.exec(`INSERT INTO turma_colaborador VALUES (1,1,2),(2,1,2),(3,2,2),(4,3,2),(5,4,2);
      INSERT INTO conclusao_evento VALUES
      (1,1,'PENDENTE','2026-10-13 12:00:00',NULL),
      (2,2,'PENDENTE','2026-10-13 12:00:01',NULL),
      (3,3,'PENDENTE','2026-10-12 12:00:00',NULL),
      (4,4,'PENDENTE','2026-10-12 12:00:00',NULL),
      (5,5,'PENDENTE','2026-10-12 12:00:00',NULL);`);
    const rows = await candidates("pending-validations");
    expect(rows.map(row => [row.cursor, row.usuario_id, row.evento_id])).toEqual([["1", "3", "1"], ["5", "3", "4"]]);
    expect(rows.map(row => notificationFor("pending-validations", row, context).document.evento_id)).toEqual([1, 4]);
    await db.exec(`UPDATE conclusao_evento SET status='CONCLUIDO', data_validacao='2026-10-15 10:00:00';`);
    expect(await candidates("pending-validations")).toEqual([]);
  });
});
