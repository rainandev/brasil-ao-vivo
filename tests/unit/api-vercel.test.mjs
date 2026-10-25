// Testes 8 e 9: cabeçalhos de cache da rota e compatibilidade com o deploy na Vercel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { iniciarMockTse } from "../support/mock-tse.mjs";
import { cenario } from "../support/fixtures.mjs";
import { limparMemoria } from "../../lib/fonte-tse.js";

const raiz = new URL("../../", import.meta.url).pathname;
let mock;
let handler;

before(async () => {
  mock = await iniciarMockTse();
  process.env.PERMITIR_FONTE_TESTE = "1";
  process.env.TSE_BASE_URL = mock.url;
  delete process.env.VERCEL;
  handler = (await import("../../api/resultados.js")).default;
});
after(async () => {
  delete process.env.PERMITIR_FONTE_TESTE;
  delete process.env.TSE_BASE_URL;
  await mock.fechar();
});

function chamar(url, method = "GET") {
  return new Promise((ok) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (corpo) => ok({ status: res.statusCode, headers, corpo: corpo ? JSON.parse(corpo) : null }),
    };
    handler({ url, method }, res);
  });
}

test("rota: apuração em andamento é cacheada 20 s na CDN e revalidada no navegador", async () => {
  limparMemoria();
  mock.usarArquivos(cenario({ st: 100 }));
  const r = await chamar("/api/resultados?turno=2");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=20, stale-while-revalidate=40");
  assert.equal(r.corpo.turno, 2);
  assert.equal(r.corpo.fonte.teste, true);
});

test("rota: sem nenhum arquivo publicado, cache curto e nenhum dado", async () => {
  limparMemoria();
  mock.definir(() => ({ status: 404 }));
  const r = await chamar("/api/resultados");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=10");
  assert.equal(r.corpo.arquivosLidos, 0);
  assert.ok(Object.values(r.corpo.escopos).every((e) => e.dados === null));
});

test("rota: resultado encerrado fica 10 min na CDN", async () => {
  limparMemoria();
  const arq = cenario({ st: 1000, and: "f" });
  mock.definir((uf) => ({ corpo: arq[uf] || { ...arq.br, cdabr: "ZZ" } }));
  const r = await chamar("/api/resultados?turno=2");
  assert.match(r.headers["cache-control"], /s-maxage=600/);
});

test("rota: valida turno e método", async () => {
  assert.equal((await chamar("/api/resultados?turno=3")).status, 400);
  assert.equal((await chamar("/api/resultados", "POST")).status, 405);
});

test("vercel.json válido e saída estática em public/", () => {
  const v = JSON.parse(readFileSync(join(raiz, "vercel.json"), "utf8"));
  assert.equal(v.outputDirectory, "public");
  assert.ok(existsSync(join(raiz, "public/index.html")));
  assert.ok(existsSync(join(raiz, "public/data/brasil-uf.json")));
  assert.ok(v.functions["api/resultados.js"].maxDuration <= 60, "limite do plano Hobby");
  const pkg = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.scripts.build, undefined, "sem etapa de build: a Vercel publica public/ direto");
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], "função sem dependências de runtime");
});

function arquivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : [p];
  });
}

test("public/ não contém dados de teste, segredos nem dependências de Node", () => {
  for (const f of arquivos(join(raiz, "public"))) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, /TESTE ALFA|TESTE BETA|fixtures/, `${f} contém dados de teste`);
    assert.doesNotMatch(t, /(api[_-]?key|secret|token|password)\s*[:=]/i, `${f} parece conter segredo`);
    if (f.endsWith(".js")) assert.doesNotMatch(t, /from\s+["']node:/, `${f} importa módulo de Node`);
  }
});

test("mapa tem as 27 UFs com geometria real", () => {
  const geo = JSON.parse(readFileSync(join(raiz, "public/data/brasil-uf.json"), "utf8"));
  assert.equal(geo.estados.length, 27);
  for (const e of geo.estados) assert.match(e.d, /^M[\d.,\-LZMz]+/, e.uf);
});
