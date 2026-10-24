import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { pendingRecipientsQuery } from "../src/push/query";
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(new NodeURL("./fixtures/schema.sql", import.meta.url), "utf8"));
  await db.exec("ALTER TABLE usuario ADD COLUMN firebase_uid text");
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE conclusao_evento, turma_colaborador, turma, evento, usuario, cargo, unidade;
    INSERT INTO unidade VALUES (1,1,true),(2,2,true);
    INSERT INTO cargo VALUES (1,1,true),(2,2,true);
    INSERT INTO usuario VALUES (2,1,1,'COLABORADOR','ATIVO','collaborator'),(3,1,1,'GESTOR','ATIVO','manager'),
      (4,2,2,'COLABORADOR','ATIVO','other-workspace'),(5,1,1,'COLABORADOR','DESATIVADO','inactive'),
      (6,1,1,'COLABORADOR','ATIVO',NULL);
    INSERT INTO evento VALUES (1,3,'Evento','ATIVO'),(2,3,'Cancelado','CANCELADO');
    INSERT INTO turma VALUES (1,1,'2020-01-01'),(2,1,'2030-01-01'),(3,2,'2030-01-01');`);
});
async function recipients(after = "0", limit = 100) {
  const query = pendingRecipientsQuery(after, limit);
  return (await db.query<{ user_id: string; uid: string }>(query.text, query.values)).rows.map(row => row.user_id);
}
it("qualquer prazo e várias turmas geram um único destinatário; o gestor acompanha a equipe", async () => {
  await db.exec("INSERT INTO turma_colaborador VALUES (1,1,2),(2,2,2)");
  expect(await recipients()).toEqual(["2", "3"]);
  expect(await recipients("2", 1)).toEqual(["3"]);
});
it("quem já enviou não é cobrado; apenas o gestor recebe enquanto aguarda validação", async () => {
  await db.exec(`INSERT INTO turma_colaborador VALUES (1,1,2);
    INSERT INTO conclusao_evento VALUES (1,1,'PENDENTE','2026-10-24',NULL)`);
  expect(await recipients()).toEqual(["3"]);
  await db.exec("UPDATE conclusao_evento SET status='CONCLUIDO',data_validacao='2026-10-24'");
  expect(await recipients()).toEqual([]);
});
it("exclui cancelados, vínculos entre workspaces, inativos e contas sem UID", async () => {
  await db.exec("INSERT INTO turma_colaborador VALUES (1,3,2),(2,1,4),(3,1,5)");
  expect(await recipients()).toEqual([]);
  await db.exec("INSERT INTO turma_colaborador VALUES (4,1,6)");
  expect(await recipients()).toEqual(["3"]);
});
it("rejeição é pendência; envio para validação não exige esperar 48h", async () => {
  await db.exec(`INSERT INTO turma_colaborador VALUES (1,2,2);
    INSERT INTO conclusao_evento VALUES (1,1,'REJEITADO','2026-10-24','2026-10-24')`);
  expect(await recipients()).toEqual(["2", "3"]);
});
