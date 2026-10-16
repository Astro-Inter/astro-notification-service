import { describe, expect, it, vi } from "vitest";
import { runRule, type Dependencies } from "../src/shared/runner";
import type { Candidate, Env } from "../src/shared/types";

const env: Env = { ENABLED: "true", DRY_RUN: "false", BATCH_SIZE: "1", MAX_BATCHES: "2" };
const row: Candidate = { cursor: "1", workspace_id: "1", usuario_id: "2", recurso_id: "1", referencia: "2026-10-14", nr_id: 10 };
function setup(pages: Candidate[][]) {
  const source = { page: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  for (const rows of pages) source.page.mockResolvedValueOnce(rows);
  const store = { ensureIndexes: vi.fn().mockResolvedValue(undefined),
    insertOnce: vi.fn().mockResolvedValue(true), close: vi.fn().mockResolvedValue(undefined) };
  const deps: Dependencies = { source: vi.fn().mockResolvedValue(source), store: vi.fn().mockResolvedValue(store) };
  return { source, store, deps };
}

describe("execução dos Workers", () => {
  it("desabilita regras sem abrir conexões, incluindo a aplicabilidade pendente", async () => {
    const { deps } = setup([]);
    expect(await runRule("expired-compliance", {}, undefined, deps)).toMatchObject({ reason: "disabled" });
    expect(await runRule("missing-compliance", env, undefined, deps)).toMatchObject({ reason: "applicability_pending" });
    expect(deps.source).not.toHaveBeenCalled();
    expect(deps.store).not.toHaveBeenCalled();
  });
  it("simulação não abre conexão Mongo nem cria índices", async () => {
    const { deps, source, store } = setup([[row], []]);
    const result = await runRule("expired-compliance", { ...env, DRY_RUN: "true" }, undefined, deps);
    expect(result).toMatchObject({ status: "completed", dryRun: true, candidates: 1, inserted: 0 });
    expect(deps.store).not.toHaveBeenCalled();
    expect(store.ensureIndexes).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });
  it("pagina, conta duplicatas e fecha as conexões", async () => {
    const { deps, source, store } = setup([[row], [{ ...row, cursor: "2", recurso_id: "2" }], []]);
    store.insertOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await runRule("expired-compliance", env, undefined, deps)).toMatchObject({ inserted: 1, duplicates: 1, batches: 2 });
    expect(source.page.mock.calls.map(call => call[2])).toEqual(["0", "1", "2"]);
    expect(source.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });
  it("falha antes de gravar quando o índice único não pode ser garantido", async () => {
    const { deps, source, store } = setup([[row]]);
    store.ensureIndexes.mockRejectedValue(new Error("index unavailable"));
    await expect(runRule("expired-compliance", env, undefined, deps)).rejects.toThrow("index unavailable");
    expect(store.insertOnce).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });
  it("propaga falha parcial para permitir reexecução com gravações idempotentes", async () => {
    const { deps, source, store } = setup([[row], [{ ...row, cursor: "2", recurso_id: "2" }]]);
    store.insertOnce.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("write failed"));
    await expect(runRule("expired-compliance", env, undefined, deps)).rejects.toThrow("write failed");
    expect(source.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });
  it("sinaliza truncamento em vez de registrar execução completa", async () => {
    const { deps } = setup([[row], [{ ...row, cursor: "2" }]]);
    await expect(runRule("expired-compliance", { ...env, MAX_BATCHES: "1" }, undefined, deps)).rejects.toThrow("Limite de lotes");
  });
});
