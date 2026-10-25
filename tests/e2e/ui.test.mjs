// Testes 3, 4, 5, 6 e 7 no navegador: atualização automática, consulta por estado,
// ausência de números fictícios, erros e funcionamento em celular.
// Requer Playwright + Chromium (npm i -D playwright && npx playwright install chromium).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { iniciarMockTse } from "../support/mock-tse.mjs";
import { arquivoTeste, cenario } from "../support/fixtures.mjs";
import { limparMemoria } from "../../lib/fonte-tse.js";

function carregarPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req("playwright"); } catch {
    return req(join(execSync("npm root -g").toString().trim(), "playwright"));
  }
}

let mock, servidor, base, navegador;
const PCT = /\d+,\d{2}%/;

before(async () => {
  mock = await iniciarMockTse();
  process.env.PERMITIR_FONTE_TESTE = "1";
  process.env.TSE_BASE_URL = mock.url;
  process.env.CACHE_SEGUNDOS = "0";
  const { criarServidor } = await import("../../scripts/dev-server.mjs");
  servidor = criarServidor().listen(0, "127.0.0.1");
  await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await carregarPlaywright().chromium.launch();
});
after(async () => {
  await navegador?.close();
  servidor?.close();
  await mock?.fechar();
});

async function abrir(caminho = "/", opcoes = {}) {
  limparMemoria(); // cada teste começa sem leituras guardadas no servidor
  const pagina = await navegador.newPage(opcoes);
  // Fotos e fontes externas não fazem parte do teste.
  await pagina.route(/fonts\.(googleapis|gstatic)\.com|\/fotos\//, (r) => r.abort());
  const sep = caminho.includes("?") ? "&" : "?";
  await pagina.goto(`${base}${caminho}${sep}intervalo=400`);
  return pagina;
}

test("sem publicação oficial: mostra aguardando e nenhum número de votos", async () => {
  mock.definir(() => ({ status: 404 }));
  const p = await abrir();
  await p.getByText("Aguardando divulgação dos resultados oficiais").first().waitFor();
  assert.doesNotMatch(await p.locator("#candidatos").innerText(), /\d/);
  assert.doesNotMatch(await p.locator("#indicadores").innerText(), /\d/);
  assert.equal(await p.locator(".uf.c-sem-dados").count(), 27);
  assert.equal(await p.locator("#aviso-teste").isVisible(), true, "fonte simulada sempre identificada");
  await p.close();
});

test("arquivo publicado com 0 seções: mostra candidatos oficiais, sem percentuais", async () => {
  const arq = Object.fromEntries(Object.entries(cenario()).map(([uf]) => [uf, arquivoTeste({ uf, st: 0 })]));
  mock.usarArquivos(arq);
  const p = await abrir();
  await p.locator("#candidatos .cand-nome", { hasText: "CANDIDATA TESTE ALFA" }).waitFor();
  const texto = await p.locator("#candidatos").innerText();
  assert.doesNotMatch(texto, PCT);
  assert.match(texto, /Aguardando divulgação/);
  await p.close();
});

test("atualiza automaticamente quando a fonte publica dados novos, sem recarregar", async () => {
  mock.usarArquivos(cenario({ st: 100, hg: "18:00:00" }));
  const p = await abrir();
  await p.locator(".cand-pct").first().waitFor();
  const antes = await p.locator("#status-secoes").innerText();
  await p.evaluate(() => { window.__marcador = "mesma-pagina"; });
  mock.usarArquivos(cenario({ st: 900, hg: "18:30:00", deslocamento: 5000 }));
  await p.waitForFunction((a) => document.getElementById("status-secoes").textContent !== a, antes, { timeout: 5000 });
  assert.match(await p.locator("#status-secoes").innerText(), /90,00%/);
  assert.match(await p.locator("#hora-referencia").innerText(), /18:30:00/);
  assert.equal(await p.evaluate(() => window.__marcador), "mesma-pagina");
  await p.close();
});

test("não volta para números antigos se a fonte devolver uma versão anterior", async () => {
  mock.usarArquivos(cenario({ st: 900, hg: "19:00:00" }));
  const p = await abrir();
  await p.getByText("90,00%").first().waitFor();
  mock.usarArquivos(cenario({ st: 100, hg: "18:00:00" }));
  await p.waitForTimeout(1500);
  assert.match(await p.locator("#status-secoes").innerText(), /90,00%/);
  await p.close();
});

test("selecionar estado no mapa e no seletor mostra os dados daquele estado", async () => {
  const arq = cenario({ st: 500 });
  mock.usarArquivos(arq);
  const p = await abrir();
  await p.locator('.uf[data-uf="sp"]').waitFor();
  await p.locator('.uf[data-uf="sp"]').click();
  await p.locator("#escopo-nome", { hasText: "São Paulo" }).waitFor();
  const sp = arq.sp.carg[0].agr[0].par.map((x) => x.cand[0].pvap);
  const texto = await p.locator("#candidatos").innerText();
  for (const pct of sp) assert.ok(texto.includes(`${pct}%`), `SP ${pct}%`);
  assert.equal(await p.locator('.uf[data-uf="sp"]').getAttribute("aria-pressed"), "true");
  assert.match(new URL(p.url()).search, /uf=sp/);

  await p.selectOption("#seletor-uf", "ba");
  await p.locator("#escopo-nome", { hasText: "Bahia" }).waitFor();
  assert.ok((await p.locator("#candidatos").innerText()).includes(`${arq.ba.carg[0].agr[0].par[0].cand[0].pvap}%`));

  await p.locator("#voltar-brasil").click();
  await p.locator("#escopo-nome", { hasText: "Brasil" }).waitFor();
  assert.match(await p.locator('.uf[data-uf="ba"]').getAttribute("aria-label"), /Bahia: .* lidera com \d+,\d{2}%/);
  await p.close();
});

test("teclado: estado acessível com Tab + Enter", async () => {
  mock.usarArquivos(cenario({ st: 500 }));
  const p = await abrir();
  await p.locator('.uf[data-uf="rs"]').focus();
  await p.keyboard.press("Enter");
  await p.locator("#escopo-nome", { hasText: "Rio Grande do Sul" }).waitFor();
  await p.close();
});

test("queda da fonte: mantém última leitura válida e avisa, sem trocar por números inventados", async () => {
  mock.usarArquivos(cenario({ st: 700, hg: "20:00:00" }));
  const p = await abrir();
  await p.getByText("70,00%").first().waitFor();
  const cand = await p.locator("#candidatos").innerText();
  mock.definir(() => ({ status: 503 }));
  await p.locator("#mensagem", { hasText: /Falha ao atualizar/ }).waitFor({ timeout: 5000 });
  assert.equal(await p.locator("#candidatos").innerText(), cand);
  await p.close();
});

test("dados incompletos em um estado não afetam os outros", async () => {
  const arq = cenario({ st: 400 });
  arq.pe = { ...arq.pe, carg: undefined };
  mock.usarArquivos(arq);
  const p = await abrir("/?uf=pe");
  await p.getByText("Aguardando divulgação dos resultados oficiais").first().waitFor();
  assert.doesNotMatch(await p.locator("#candidatos").innerText(), /\d/);
  assert.match(await p.locator('.uf[data-uf="pb"]').getAttribute("class"), /c-(a|b|empate)/);
  await p.close();
});

test("celular (390 px): sem rolagem horizontal, candidatos antes do mapa, toque seleciona estado", async () => {
  mock.usarArquivos(cenario({ st: 500 }));
  const p = await abrir("/", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.locator(".cand-pct").first().waitFor();
  const [sw, cw] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(sw <= cw, `rolagem horizontal: ${sw} > ${cw}`);
  const yCand = (await p.locator("#painel-candidatos").boundingBox()).y;
  const yMapa = (await p.locator("#mapa-palco").boundingBox()).y;
  assert.ok(yCand < yMapa, "no celular, candidatos aparecem primeiro");
  await p.locator('.uf[data-uf="mg"]').scrollIntoViewIfNeeded();
  await p.locator('.uf[data-uf="mg"]').tap();
  await p.locator("#escopo-nome", { hasText: "Minas Gerais" }).waitFor();
  await p.close();
});

test("1º turno: troca de aba consulta a eleição 6257", async () => {
  mock.definir((uf, ele) => (ele === "6257" ? { corpo: arquivoTeste({ uf, ele: "6257", st: 1000, votos: [7, 3], and: "f" }) } : { status: 404 }));
  const p = await abrir();
  await p.getByRole("button", { name: "1º turno" }).click();
  await p.locator("#selo-status", { hasText: "Resultado final" }).waitFor();
  assert.match(new URL(p.url()).search, /turno=1/);
  await p.close();
});
