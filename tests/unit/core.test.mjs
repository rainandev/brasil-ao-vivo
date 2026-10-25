// Testes 1, 2, 4, 5 e 6: leitura do formato oficial, votos e percentuais, recortes por estado,
// ausência de números quando não há dados e tratamento de dados incompletos.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ErroArquivo, candidatosReferencia, corEstado, formatarPct, formatarVotos, instanteTse, lerArquivo,
  maisNovo, mesclar, urlArquivo, urlFoto,
} from "../../public/js/core.js";
import { arquivoTeste } from "../support/fixtures.mjs";

const cfg = { base: "https://resultados.tse.jus.br", ambiente: "oficial", ciclo: "ele2026", eleicao: "6258", cargo: 1 };

test("monta a URL oficial do arquivo unificado (-u.json) do 2º turno", () => {
  assert.equal(urlArquivo(cfg, "br"), "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json");
  assert.equal(urlArquivo(cfg, "SP"), "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp-c0001-e006258-u.json");
  assert.equal(urlFoto(cfg, "280001234567"), "https://resultados.tse.jus.br/oficial/ele2026/6258/fotos/br/280001234567.jpeg");
  assert.equal(urlFoto(cfg, "../x"), null);
});

test("lê votos absolutos e usa o percentual oficial (pvap) sem recalcular", () => {
  const json = arquivoTeste({ uf: "sp", st: 900, ts: 1000, votos: [6000, 4000], vb: 50, tvn: 150, a: 800 });
  const d = lerArquivo(json, { uf: "sp", eleicao: "6258" });
  assert.equal(d.uf, "sp");
  assert.equal(d.status, "parcial");
  assert.deepEqual(d.candidatos.map((c) => [c.nome, c.votos, c.pct]), [
    ["CANDIDATA TESTE ALFA", 6000, "60,00"],
    ["CANDIDATO TESTE BETA", 4000, "40,00"],
  ]);
  assert.equal(d.votos.validos, 10000);
  assert.equal(d.votos.brancos, 50);
  assert.equal(d.votos.nulos, 150);
  assert.equal(d.secoes.totalizadas, 900);
  assert.equal(d.secoes.pct, "90,00");
  assert.deepEqual(d.avisos, []);
});

test("percentual exibido é o texto oficial, mesmo quando o arredondamento difere da conta simples", () => {
  const json = arquivoTeste({ st: 10, votos: [1, 2] });
  json.carg[0].agr[0].par[0].cand[0].pvap = "33,33";
  json.carg[0].agr[0].par[1].cand[0].pvap = "66,67";
  const d = lerArquivo(json);
  assert.equal(d.candidatos[0].pct, "66,67");
  assert.equal(formatarPct(d.candidatos[0].pct), "66,67%");
  assert.deepEqual(d.avisos, []);
});

test("ordena candidatos por votos e, antes da apuração, pelo número", () => {
  const antes = lerArquivo(arquivoTeste({ st: 0 }));
  assert.equal(antes.status, "aguardando");
  assert.deepEqual(antes.candidatos.map((c) => c.numero), ["91", "92"]);
  const depois = lerArquivo(arquivoTeste({ st: 1, votos: [10, 30] }));
  assert.deepEqual(depois.candidatos.map((c) => c.numero), ["92", "91"]);
});

test("identifica resultado final pelo campo de andamento do TSE", () => {
  assert.equal(lerArquivo(arquivoTeste({ st: 1000, votos: [5, 6], and: "f" })).status, "final");
  assert.equal(lerArquivo(arquivoTeste({ st: 1000, votos: [5, 6], and: "F" })).status, "final");
  assert.equal(lerArquivo(arquivoTeste({ st: 1000, votos: [5, 6], and: "p" })).status, "parcial");
});

test("rejeita arquivos de outra UF, outra eleição ou com estrutura incompleta", () => {
  const ok = arquivoTeste({ uf: "rj", st: 1, votos: [1, 1] });
  assert.throws(() => lerArquivo(ok, { uf: "sp" }), (e) => e instanceof ErroArquivo && e.codigo === "ABRANGENCIA");
  assert.throws(() => lerArquivo(ok, { eleicao: "6257" }), (e) => e.codigo === "ELEICAO");
  assert.throws(() => lerArquivo(null), (e) => e.codigo === "ESTRUTURA");
  assert.throws(() => lerArquivo([]), (e) => e.codigo === "ESTRUTURA");
  assert.throws(() => lerArquivo({ ...ok, s: undefined }), (e) => e.codigo === "ESTRUTURA");
  assert.throws(() => lerArquivo({ ...ok, carg: [] }), (e) => e.codigo === "ESTRUTURA");
  assert.throws(() => lerArquivo({ ...ok, s: { st: "11", ts: "10" } }), (e) => e.codigo === "SECOES");
  const votoRuim = structuredClone(ok);
  votoRuim.carg[0].agr[0].par[0].cand[0].vap = "1.234";
  assert.throws(() => lerArquivo(votoRuim), (e) => e.codigo === "VOTOS");
});

test("sinaliza inconsistência entre votos, válidos e percentuais sem inventar correção", () => {
  const json = arquivoTeste({ st: 5, votos: [600, 400] });
  json.v.vv = "1100";
  const d = lerArquivo(json);
  assert.ok(d.avisos.some((a) => a.includes("soma dos votos")));
  assert.equal(d.candidatos[0].pct, "60,00"); // continua mostrando o oficial
});

test("converte data/hora do TSE (Brasília, UTC-3)", () => {
  assert.equal(new Date(instanteTse("25/10/2026", "19:30:05")).toISOString(), "2026-10-25T22:30:05.000Z");
  assert.equal(instanteTse("2026-10-25", "19:30"), null);
});

test("não retrocede para leituras mais antigas", () => {
  const nova = lerArquivo(arquivoTeste({ st: 800, votos: [8, 2], hg: "20:00:00" }));
  const velha = lerArquivo(arquivoTeste({ st: 700, votos: [7, 3], hg: "19:59:00" }));
  assert.equal(maisNovo(nova, velha), true);
  assert.equal(maisNovo(velha, nova), false);
  const ant = { eleicao: "6258", escopos: { br: { dados: nova, erro: null } } };
  const prox = { eleicao: "6258", escopos: { br: { dados: velha, erro: null } } };
  assert.equal(mesclar(ant, prox).escopos.br.dados.secoes.totalizadas, 800);
});

test("falha num recorte mantém a última leitura válida marcada como desatualizada", () => {
  const d = lerArquivo(arquivoTeste({ uf: "ba", st: 10, votos: [3, 1] }));
  const ant = { eleicao: "6258", escopos: { ba: { dados: d, erro: null } } };
  const prox = { eleicao: "6258", escopos: { ba: { dados: null, erro: { codigo: "HTTP" } } } };
  const m = mesclar(ant, prox).escopos.ba;
  assert.equal(m.dados, d);
  assert.equal(m.desatualizado, true);
});

test("cor do estado: sem dados, empate, faixas por margem e candidato de referência", () => {
  const br = lerArquivo(arquivoTeste({ st: 1, votos: [55, 45] }));
  const ref = candidatosReferencia(br);
  assert.deepEqual(ref, ["91", "92"]);
  assert.equal(corEstado(null, ref).classe, "sem-dados");
  assert.equal(corEstado(lerArquivo(arquivoTeste({ st: 0 })), ref).classe, "sem-dados");
  assert.equal(corEstado(lerArquivo(arquivoTeste({ st: 1, votos: [5005, 4995] })), ref).classe, "empate");
  assert.equal(corEstado(lerArquivo(arquivoTeste({ st: 1, votos: [55, 45] })), ref).classe, "a-2");
  assert.equal(corEstado(lerArquivo(arquivoTeste({ st: 1, votos: [47, 53] })), ref).classe, "b-1");
  assert.equal(corEstado(lerArquivo(arquivoTeste({ st: 1, votos: [20, 80] })), ref).classe, "b-3");
});

test("formatação nunca transforma ausência de dado em zero", () => {
  assert.equal(formatarVotos(null), "—");
  assert.equal(formatarPct(null), "—");
  assert.equal(formatarVotos(53879538), "53.879.538");
});
