// Testes no navegador: atualização automática, consulta por estado (mapa 3D e 2D),
// ausência de números sem dado oficial, erros, 1º turno real e celulares de 320 a 430 px.
// Requer Playwright + Chromium (npm i -D playwright && npx playwright install chromium).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { criarFetchFalso } from "../support/mock-tse.mjs";
import { arquivoTeste, cenario } from "../support/fixtures.mjs";
import { limparMemoria } from "../../lib/fonte-tse.js";
import { criarServidor } from "../../scripts/dev-server.mjs";

function carregarPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req("playwright"); } catch {
    return req(join(execSync("npm root -g").toString().trim(), "playwright"));
  }
}

const tse = criarFetchFalso();
let servidor, base, navegador;
const PCT = /\d+,\d{2}%/;

before(async () => {
  process.env.CACHE_SEGUNDOS = "0"; // sem cache no servidor de teste: cada consulta vê o dado mais recente
  servidor = criarServidor({ fetchImpl: tse.fetch }).listen(0, "127.0.0.1");
  await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  // WebGL por software para o mapa 3D funcionar sem GPU.
  navegador = await carregarPlaywright().chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
});
after(async () => {
  await navegador?.close();
  servidor?.close();
});

async function abrir(caminho = "/", opcoes = {}) {
  limparMemoria(); // cada teste começa sem leituras guardadas no servidor
  const pagina = await navegador.newPage(opcoes);
  await pagina.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const sep = caminho.includes("?") ? "&" : "?";
  await pagina.goto(`${base}${caminho}${sep}intervalo=400`);
  return pagina;
}

test("2º turno antes da publicação: aguardando, sem números, e resumo real do 1º turno", async () => {
  tse.definir(() => ({ status: 404 }));
  const p = await abrir();
  await p.locator("#candidatos .vazio").waitFor();
  assert.doesNotMatch(await p.locator("#candidatos").innerText(), /\d/);
  assert.doesNotMatch(await p.locator("#indicadores").innerText(), /\d/);
  const resumo = await p.locator("#resumo-1t").innerText();
  assert.match(resumo, /FLAVIO BOLSONARO[\s\S]*47,03%[\s\S]*56\.104\.503 votos/);
  assert.match(resumo, /LULA[\s\S]*45,16%[\s\S]*53\.879\.538 votos/);
  const fotos = await p.locator("#resumo-1t img").evaluateAll((imgs) => imgs.map((i) => [i.getAttribute("src"), i.naturalWidth > 0]));
  assert.deepEqual(fotos.map((f) => f[0]).sort(), ["/img/candidatos/flavio-bolsonaro.webp", "/img/candidatos/lula.webp"]);
  assert.ok(fotos.every((f) => f[1]), "fotos carregadas");
  await p.locator("#indicador-texto", { hasText: "aguardando TSE" }).waitFor();
  assert.equal(await p.locator("#hora-consulta").innerText(), "—", "nenhum arquivo lido: não há consulta bem-sucedida");
  assert.equal(await p.locator("#credito").getAttribute("href"), "https://www.instagram.com/rainan.zx/");
  assert.match(await p.locator("#credito").innerText(), /@rainan\.zx/);
  assert.ok(await p.locator(".credito-foto").evaluate((i) => i.complete && i.naturalWidth > 0), "foto do crédito no rodapé");
  await p.close();
});

test("1º turno com o TSE fora do ar: mostra a totalização final real com as fotos", async () => {
  tse.definir(() => ({ rede: true }));
  const p = await abrir("/?turno=1");
  await p.locator(".cand-pct").first().waitFor();
  await p.waitForTimeout(1300); // contadores animados terminam no valor oficial
  const texto = await p.locator("#candidatos").innerText();
  assert.match(texto, /FLAVIO BOLSONARO[\s\S]*47,03%[\s\S]*56\.104\.503 votos[\s\S]*LULA[\s\S]*45,16%[\s\S]*53\.879\.538 votos/);
  assert.equal(await p.locator("#selo-status").innerText(), "RESULTADO FINAL");
  assert.equal(await p.locator("#hora-consulta").innerText(), "—", "registro estático não conta como consulta ao TSE");
  const src = await p.locator("#candidatos img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")));
  assert.deepEqual(src, ["/img/candidatos/flavio-bolsonaro.webp", "/img/candidatos/lula.webp"]);
  await p.selectOption("#seletor-uf", "ba");
  await p.locator("#candidatos", { hasText: "66,17%" }).waitFor();
  await p.close();
});

test("arquivo publicado com 0 seções: candidatos oficiais, sem percentuais", async () => {
  const arq = Object.fromEntries(Object.keys(cenario()).map((uf) => [uf, arquivoTeste({ uf, st: 0 })]));
  tse.usarArquivos(arq);
  const p = await abrir();
  await p.locator("#candidatos .cand-nome", { hasText: "CANDIDATA TESTE ALFA" }).waitFor();
  const texto = await p.locator("#candidatos").innerText();
  assert.doesNotMatch(texto, PCT);
  assert.match(texto, /Aguardando divulgação/);
  await p.close();
});

test("atualiza automaticamente quando a fonte publica dados novos, sem recarregar", async () => {
  tse.usarArquivos(cenario({ st: 100, hg: "18:00:00" }));
  const p = await abrir();
  await p.locator(".cand-pct").first().waitFor();
  const antes = await p.locator("#status-secoes").innerText();
  await p.evaluate(() => { window.__marcador = "mesma-pagina"; });
  tse.usarArquivos(cenario({ st: 900, hg: "18:30:00", deslocamento: 5000 }));
  await p.waitForFunction((a) => document.getElementById("status-secoes").textContent !== a, antes, { timeout: 8000 });
  assert.match(await p.locator("#status-secoes").innerText(), /90,00%/);
  assert.match(await p.locator("#hora-referencia").innerText(), /18:30:00/);
  assert.equal(await p.evaluate(() => window.__marcador), "mesma-pagina");
  await p.close();
});

test("não volta para números antigos se a fonte devolver uma versão anterior", async () => {
  tse.usarArquivos(cenario({ st: 900, hg: "19:00:00" }));
  const p = await abrir();
  await p.locator("#status-secoes", { hasText: "90,00%" }).waitFor();
  tse.usarArquivos(cenario({ st: 100, hg: "18:00:00" }));
  await p.waitForTimeout(1500);
  assert.match(await p.locator("#status-secoes").innerText(), /90,00%/);
  await p.close();
});

test("mapa 3D: estados sobem na entrada, toque/clique seleciona e mostra o rótulo", async () => {
  const arq = cenario({ st: 500 });
  tse.usarArquivos(arq);
  const p = await abrir("/?mapa=3d", { viewport: { width: 1280, height: 900 } });
  await p.locator(".mapa3d-canvas").waitFor();
  await p.waitForFunction(() => window.__bav.estado.mapa3d?.inspecionar().every((s) => Math.abs(s.z) < 1), null, { timeout: 15000 });
  await p.locator(".cand-pct").first().waitFor();
  const alvo = await p.evaluate(() => window.__bav.estado.mapa3d.projetar("sp"));
  await p.mouse.click(alvo.clientX, alvo.clientY + 6);
  await p.locator("#escopo-nome", { hasText: "São Paulo" }).waitFor();
  await p.locator(".rotulo-3d", { hasText: "São Paulo" }).waitFor();
  for (const par of arq.sp.carg[0].agr[0].par) await p.locator("#candidatos", { hasText: `${par.cand[0].pvap}%` }).waitFor();
  await p.close();
});

test("mapa 2D: clique, seletor e voltar ao Brasil", async () => {
  const arq = cenario({ st: 500 });
  tse.usarArquivos(arq);
  const p = await abrir("/?mapa=2d");
  await p.locator('.uf[data-uf="sp"]').waitFor();
  await p.locator('.uf[data-uf="sp"]').click();
  await p.locator("#escopo-nome", { hasText: "São Paulo" }).waitFor();
  assert.equal(await p.locator('.uf[data-uf="sp"]').getAttribute("aria-pressed"), "true");
  assert.match(new URL(p.url()).search, /uf=sp/);
  await p.selectOption("#seletor-uf", "ba");
  await p.locator("#escopo-nome", { hasText: "Bahia" }).waitFor();
  await p.locator("#candidatos", { hasText: `${arq.ba.carg[0].agr[0].par[0].cand[0].pvap}%` }).waitFor();
  await p.locator("#voltar-brasil").click();
  await p.locator("#escopo-nome", { hasText: "Brasil" }).waitFor();
  assert.match(await p.locator('.uf[data-uf="ba"]').getAttribute("aria-label"), /Bahia: .* lidera com \d+,\d{2}%/);
  await p.close();
});

test("alternar 3D ↔ 2D e teclado (Tab + Enter) no mapa 2D", async () => {
  tse.usarArquivos(cenario({ st: 500 }));
  const p = await abrir("/?mapa=3d");
  await p.locator(".mapa3d-canvas").waitFor();
  await p.getByRole("button", { name: "2D" }).click();
  await p.locator('.uf[data-uf="rs"]').focus();
  await p.keyboard.press("Enter");
  await p.locator("#escopo-nome", { hasText: "Rio Grande do Sul" }).waitFor();
  await p.getByRole("button", { name: "3D" }).click();
  await p.locator(".mapa3d-canvas").waitFor();
  await p.close();
});

test("queda da fonte: mantém última leitura válida e avisa, sem inventar números", async () => {
  tse.usarArquivos(cenario({ st: 700, hg: "20:00:00" }));
  const p = await abrir();
  await p.locator("#status-secoes", { hasText: "70,00%" }).waitFor();
  await p.waitForTimeout(1300);
  const cand = await p.locator("#candidatos").innerText();
  tse.definir(() => ({ status: 503 }));
  await p.locator("#mensagem", { hasText: /última leitura válida/ }).waitFor({ timeout: 8000 });
  assert.equal(await p.locator("#candidatos").innerText(), cand);
  await p.close();
});

test("dados incompletos em um estado não afetam os outros", async () => {
  const arq = cenario({ st: 400 });
  arq.pe = { ...arq.pe, carg: undefined };
  tse.usarArquivos(arq);
  const p = await abrir("/?uf=pe&mapa=2d");
  await p.locator("#candidatos .vazio").waitFor();
  assert.doesNotMatch(await p.locator("#candidatos").innerText(), /\d/);
  await p.waitForFunction(() => /c-(a|b|empate)/.test(document.querySelector('.uf[data-uf="pb"]')?.getAttribute("class") || ""));
  await p.close();
});

for (const largura of [320, 360, 390, 430]) {
  test(`celular ${largura} px: sem rolagem lateral, candidatos antes do mapa, toque seleciona estado`, async () => {
    tse.usarArquivos(cenario({ st: 500 }));
    const p = await abrir("/?mapa=2d", { viewport: { width: largura, height: 800 }, hasTouch: true, isMobile: true });
    await p.locator(".cand-pct").first().waitFor();
    const [sw, cw] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw, `rolagem horizontal: ${sw} > ${cw}`);
    const yCand = (await p.locator("#painel-candidatos").boundingBox()).y;
    const yMapa = (await p.locator("#mapa-palco").boundingBox()).y;
    assert.ok(yCand < yMapa, "no celular, candidatos aparecem primeiro");
    for (const b of await p.locator(".turno, .alternar-mapa button, #seletor-uf").all()) {
      const caixa = await b.boundingBox();
      assert.ok(caixa.height >= 40, `alvo de toque pequeno: ${caixa.height}px`);
    }
    await p.locator('.uf[data-uf="mg"]').scrollIntoViewIfNeeded();
    await p.locator('.uf[data-uf="mg"]').tap();
    await p.locator("#escopo-nome", { hasText: "Minas Gerais" }).waitFor();
    await p.close();
  });
}

test("celular com mapa 3D: toque no estado seleciona", async () => {
  tse.usarArquivos(cenario({ st: 500 }));
  const p = await abrir("/?mapa=3d", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.locator(".mapa3d-canvas").waitFor();
  await p.locator("#mapa-palco").scrollIntoViewIfNeeded();
  await p.waitForFunction(() => window.__bav.estado.mapa3d?.inspecionar().every((s) => Math.abs(s.z) < 1), null, { timeout: 15000 });
  const alvo = await p.evaluate(() => window.__bav.estado.mapa3d.projetar("ba"));
  await p.touchscreen.tap(alvo.clientX, alvo.clientY + 6);
  await p.locator("#escopo-nome", { hasText: "Bahia" }).waitFor();
  await p.close();
});

test("1º turno ↔ 2º turno: troca de aba consulta a eleição 6257", async () => {
  tse.definir((uf, ele) => (ele === "6257" ? { corpo: arquivoTeste({ uf, ele: "6257", st: 1000, votos: [7, 3], and: "f" }) } : { status: 404 }));
  const p = await abrir();
  await p.getByRole("button", { name: "1º turno" }).click();
  await p.locator("#selo-status", { hasText: "Resultado final" }).waitFor();
  assert.match(new URL(p.url()).search, /turno=1/);
  assert.equal(await p.locator("#resumo-1t").isHidden(), true);
  await p.close();
});

test("movimento reduzido: começa no mapa 2D e sem animações", async () => {
  tse.definir(() => ({ status: 404 }));
  const p = await abrir("/", { reducedMotion: "reduce" });
  await p.locator('.uf[data-uf="sp"]').waitFor();
  assert.equal(await p.evaluate(() => window.__bav.estado.modoMapa), "2d");
  await p.close();
});
