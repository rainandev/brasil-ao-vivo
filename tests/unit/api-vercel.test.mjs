// Testes 8 e 9: cabeçalhos de cache da rota e compatibilidade com o deploy na Vercel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { criarFetchFalso } from "../support/mock-tse.mjs";
import { cenario } from "../support/fixtures.mjs";
import { limparMemoria, responderResultados } from "../../lib/fonte-tse.js";
import handler from "../../api/resultados.js";

const raiz = new URL("../../", import.meta.url).pathname;
const tse = criarFetchFalso();

function chamar(url, method = "GET", fn = (req, res) => responderResultados(req, res, { fetchImpl: tse.fetch })) {
  return new Promise((ok) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (corpo) => ok({ status: res.statusCode, headers, corpo: corpo ? JSON.parse(corpo) : null }),
    };
    fn({ url, method }, res);
  });
}

test("rota: apuração em andamento é cacheada 20 s na CDN e revalidada no navegador", async () => {
  limparMemoria();
  tse.usarArquivos(cenario({ st: 100 }));
  const r = await chamar("/api/resultados?turno=2");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=20, stale-while-revalidate=40");
  assert.equal(r.corpo.turno, 2);
  assert.equal(r.corpo.fonte.base, "https://resultados.tse.jus.br");
});

test("rota: sem nenhum arquivo publicado, cache curto e nenhum dado", async () => {
  limparMemoria();
  tse.definir(() => ({ status: 404 }));
  const r = await chamar("/api/resultados");
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=10");
  assert.equal(r.corpo.arquivosLidos, 0);
  assert.ok(Object.values(r.corpo.escopos).every((e) => e.dados === null));
});

test("rota: resultado encerrado fica 10 min na CDN", async () => {
  limparMemoria();
  const arq = cenario({ st: 1000, and: "f" });
  tse.definir((uf) => ({ corpo: arq[uf] || { ...arq.br, cdabr: "ZZ" } }));
  const r = await chamar("/api/resultados?turno=2");
  assert.match(r.headers["cache-control"], /s-maxage=600/);
});

test("rota: valida turno e método", async () => {
  assert.equal((await chamar("/api/resultados?turno=3")).status, 400);
  assert.equal((await chamar("/api/resultados", "POST")).status, 405);
});

test("função da Vercel exporta o handler padrão e consulta o TSE oficial", async () => {
  assert.equal(typeof handler, "function");
  assert.equal((await chamar("/api/resultados", "POST", handler)).status, 405);
});

test("vercel.json válido e saída estática em public/", () => {
  const v = JSON.parse(readFileSync(join(raiz, "vercel.json"), "utf8"));
  assert.equal(v.outputDirectory, "public");
  for (const f of ["index.html", "data/brasil-uf.json", "data/primeiro-turno-registro.js", "vendor/three/three.module.min.js",
    "vendor/three/addons/loaders/SVGLoader.js", "img/candidatos/lula.webp", "img/candidatos/flavio-bolsonaro.webp", "img/rainan.webp"]) {
    assert.ok(existsSync(join(raiz, "public", f)), f);
  }
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

test("código publicado não tem dados de teste, modo simulado, segredos nem dependências de Node", () => {
  const codigo = [...arquivos(join(raiz, "public")).filter((f) => !f.includes("/vendor/") && /\.(js|html|css|json)$/.test(f)),
    ...arquivos(join(raiz, "api")), ...arquivos(join(raiz, "lib"))];
  for (const f of codigo) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, /TESTE ALFA|TESTE BETA|fixtures|PERMITIR_FONTE_TESTE|TSE_BASE_URL/, `${f} contém dado ou modo de teste`);
    assert.doesNotMatch(t, /(api[_-]?key|secret|token|password)\s*[:=]/i, `${f} parece conter segredo`);
    if (f.includes("/public/") && f.endsWith(".js")) assert.doesNotMatch(t, /from\s+["']node:/, `${f} importa módulo de Node`);
  }
});

test("mapa tem as 27 UFs com geometria real", () => {
  const geo = JSON.parse(readFileSync(join(raiz, "public/data/brasil-uf.json"), "utf8"));
  assert.equal(geo.estados.length, 27);
  for (const e of geo.estados) assert.match(e.d, /^M[\d.,\-LZMz]+/, e.uf);
});
