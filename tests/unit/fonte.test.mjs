// Testes 1, 6 e 8: consulta à fonte, erros/indisponibilidade e cache/frequência de consultas.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { encerrado, lerConfig, limparMemoria, obterResultados } from "../../lib/fonte-tse.js";
import { ABRANGENCIAS } from "../../public/js/core.js";
import { arquivoTeste, cenario } from "../support/fixtures.mjs";

const cfgBase = { ...lerConfig({}), ttlMs: 20_000, timeoutMs: 200 };

function fetchFalso(responder) {
  const chamadas = [];
  const fn = async (url, opts) => {
    chamadas.push(url);
    const m = /dados\/([a-z]{2})\//.exec(url);
    // Como o fetch real, rejeita com AbortError quando o sinal é abortado.
    const abortado = new Promise((_, rej) => opts?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("abortado"), { name: "AbortError" }))));
    const r = await Promise.race([responder(m[1], opts), abortado]);
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      text: async () => r.bruto ?? JSON.stringify(r.corpo),
    };
  };
  fn.chamadas = chamadas;
  return fn;
}

beforeEach(() => limparMemoria());

test("consulta os 29 arquivos oficiais (Brasil, 27 UFs e Exterior) na URL do TSE", async () => {
  const arquivos = cenario({ st: 100 });
  const f = fetchFalso((uf) => (arquivos[uf] ? { corpo: arquivos[uf] } : { status: 404 }));
  const snap = await obterResultados("6258", { cfg: cfgBase, fetchImpl: f });
  assert.equal(f.chamadas.length, ABRANGENCIAS.length);
  assert.ok(f.chamadas.includes("https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json"));
  assert.equal(snap.escopos.sp.dados.uf, "sp");
  assert.equal(snap.escopos.zz.dados, null);
  assert.equal(snap.escopos.zz.erro.codigo, "NAO_PUBLICADO");
  assert.equal(snap.arquivosLidos, 28);
  assert.match(snap.escopos.br.dados.candidatos[0].foto, /\/fotos\/br\/9000000000\d\d\.jpeg$/);
});

test("cache: dentro do intervalo, novas visitas não geram novas consultas ao TSE", async () => {
  const arquivos = cenario();
  const f = fetchFalso((uf) => ({ corpo: arquivos[uf] || arquivos.br }));
  const t0 = Date.now();
  await obterResultados("6258", { cfg: cfgBase, fetchImpl: f, agora: t0 });
  await obterResultados("6258", { cfg: cfgBase, fetchImpl: f, agora: t0 + 5_000 });
  await obterResultados("6258", { cfg: cfgBase, fetchImpl: f, agora: t0 + 19_000 });
  assert.equal(f.chamadas.length, ABRANGENCIAS.length);
  await obterResultados("6258", { cfg: cfgBase, fetchImpl: f, agora: Date.now() + 21_000 });
  assert.equal(f.chamadas.length, ABRANGENCIAS.length * 2);
});

test("visitas simultâneas compartilham uma única consulta", async () => {
  const arquivos = cenario();
  const f = fetchFalso(async (uf) => { await new Promise((r) => setTimeout(r, 30)); return { corpo: arquivos[uf] || arquivos.br }; });
  await Promise.all(Array.from({ length: 50 }, () => obterResultados("6258", { cfg: cfgBase, fetchImpl: f })));
  assert.equal(f.chamadas.length, ABRANGENCIAS.length);
});

test("antes da publicação: nenhum dado, nenhum número", async () => {
  const f = fetchFalso(() => ({ status: 404 }));
  const snap = await obterResultados("6258", { cfg: cfgBase, fetchImpl: f });
  assert.equal(snap.arquivosLidos, 0);
  for (const item of Object.values(snap.escopos)) {
    assert.equal(item.dados, null);
    assert.equal(item.erro.codigo, "NAO_PUBLICADO");
  }
});

test("erro HTTP, JSON quebrado e tempo esgotado viram erros por recorte, sem derrubar o restante", async () => {
  const arquivos = cenario();
  const f = fetchFalso(async (uf) => {
    if (uf === "sp") return { status: 503 };
    if (uf === "rj") return { bruto: "{ quebrado" };
    if (uf === "mg") { await new Promise((r) => setTimeout(r, 400)); return { corpo: arquivos.mg }; }
    if (uf === "ba") return { corpo: { ...arquivos.ba, carg: undefined } };
    return arquivos[uf] ? { corpo: arquivos[uf] } : { status: 404 };
  });
  const snap = await obterResultados("6258", { cfg: cfgBase, fetchImpl: f });
  assert.equal(snap.escopos.sp.erro.codigo, "HTTP");
  assert.equal(snap.escopos.rj.erro.codigo, "JSON");
  assert.equal(snap.escopos.mg.erro.codigo, "TIMEOUT");
  assert.equal(snap.escopos.ba.erro.codigo, "ESTRUTURA");
  for (const uf of ["sp", "rj", "mg", "ba"]) assert.equal(snap.escopos[uf].dados, null);
  assert.ok(snap.escopos.pe.dados);
});

test("se a fonte cair depois, mantém a última leitura válida e a marca como desatualizada", async () => {
  const arquivos = cenario({ st: 300 });
  let fora = false;
  const f = fetchFalso((uf) => (fora ? { status: 500 } : { corpo: arquivos[uf] || arquivos.br }));
  await obterResultados("6258", { cfg: cfgBase, fetchImpl: f });
  fora = true;
  const snap = await obterResultados("6258", { cfg: cfgBase, fetchImpl: f, agora: Date.now() + 60_000 });
  assert.equal(snap.escopos.br.dados.secoes.totalizadas, 300 * 27);
  assert.equal(snap.escopos.br.desatualizado, true);
});

test("resposta antiga (cache da fonte) não sobrescreve leitura mais nova", async () => {
  let atual = arquivoTeste({ uf: "br", st: 900, votos: [9, 1], hg: "20:00:00" });
  const f = fetchFalso((uf) => (uf === "br" ? { corpo: atual } : { status: 404 }));
  await obterResultados("6258", { cfg: cfgBase, fetchImpl: f });
  atual = arquivoTeste({ uf: "br", st: 800, votos: [8, 2], hg: "19:55:00" });
  const snap = await obterResultados("6258", { cfg: cfgBase, fetchImpl: f, agora: Date.now() + 60_000 });
  assert.equal(snap.escopos.br.dados.secoes.totalizadas, 900);
});

test("encerrado só quando todos os recortes estão finais", async () => {
  const arquivos = cenario({ st: 1000, and: "f" });
  arquivos.zz = arquivoTeste({ uf: "zz", st: 10, ts: 10, votos: [1, 2], and: "f" });
  const parcial = { ...arquivos, sp: cenario({ st: 900, and: "p" }).sp };
  const f = fetchFalso((uf) => ({ corpo: { ...parcial[uf], ele: 6258 } }));
  assert.equal(encerrado(await obterResultados("6258", { cfg: cfgBase, fetchImpl: f })), false); // SP ainda parcial
  limparMemoria();
  const g = fetchFalso((uf) => ({ corpo: { ...arquivos[uf], ele: 6258 } }));
  assert.equal(encerrado(await obterResultados("6258", { cfg: cfgBase, fetchImpl: g })), true);
});

test("a fonte é sempre a divulgação oficial do TSE (não há modo simulado)", () => {
  assert.equal(lerConfig({}).base, "https://resultados.tse.jus.br");
  assert.equal(lerConfig({ TSE_BASE_URL: "http://x", PERMITIR_FONTE_TESTE: "1" }).base, "https://resultados.tse.jus.br");
  assert.deepEqual(lerConfig({}).eleicoes, { 1: "6257", 2: "6258" });
});

test("1º turno: sem resposta do TSE, usa o registro da totalização final (dado real)", async () => {
  const f = fetchFalso(() => ({ status: 500 }));
  const snap = await obterResultados("6257", { cfg: cfgBase, fetchImpl: f });
  const br = snap.escopos.br.dados;
  assert.equal(br.origem, "registro");
  assert.equal(br.status, "final");
  assert.deepEqual(br.candidatos.map((c) => [c.nome, c.votos, c.pct]), [
    ["FLAVIO BOLSONARO", 56104503, "47,03"],
    ["LULA", 53879538, "45,16"],
  ]);
  assert.equal(br.candidatos[0].foto, "/img/candidatos/flavio-bolsonaro.webp");
  assert.equal(snap.escopos.ba.dados.candidatos[0].pct, "66,17");
});

test("1º turno: leitura ao vivo do TSE tem prioridade sobre o registro", async () => {
  const arquivos = cenario({ ele: "6257", st: 1000, and: "f" });
  const f = fetchFalso((uf) => (arquivos[uf] ? { corpo: arquivos[uf] } : { status: 404 }));
  const snap = await obterResultados("6257", { cfg: cfgBase, fetchImpl: f });
  assert.equal(snap.escopos.sp.dados.origem, "tse");
  assert.equal(snap.escopos.zz.dados.origem, "registro"); // Exterior não veio ao vivo
});

test("2º turno nunca recebe números do registro do 1º turno", async () => {
  const snap = await obterResultados("6258", { cfg: cfgBase, fetchImpl: fetchFalso(() => ({ status: 500 })) });
  assert.ok(Object.values(snap.escopos).every((e) => e.dados === null));
});
