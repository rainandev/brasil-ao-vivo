import {
  ABRANGENCIAS, FONTE_OFICIAL, NOMES, candidatosReferencia, completarComRegistro, corEstado, dadosDoRegistro,
  fotoCandidato, formatarPct, formatarVotos, lerArquivo, maisNovo, mesclar, urlArquivo,
} from "./core.js";
import { REGISTRO_1T } from "../data/primeiro-turno-registro.js";

const params = new URLSearchParams(location.search);
const ambienteLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
// 30 s: casado com o cache de 20 s da rota e com o ritmo de publicação do TSE.
// ?intervalo=<ms> só é aceito localmente (testes automatizados).
const INTERVALO_MS = ambienteLocal && Number(params.get("intervalo")) >= 200 ? Number(params.get("intervalo")) : 30_000;
const INTERVALO_ENCERRADO_MS = 5 * 60_000;
const INTERVALO_MAX_ERRO_MS = 120_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const ELEICOES_PADRAO = { 1: "6257", 2: "6258" };
const reduzirMovimento = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);

const estado = {
  turno: params.get("turno") === "1" ? "1" : "2",
  uf: ABRANGENCIAS.includes(params.get("uf")) ? params.get("uf") : "br",
  snapshot: null,
  seqEnviada: 0,
  seqAplicada: 0,
  falhas: 0,
  timer: null,
  geo: null,
  mapa3d: null,
  modoMapa: null,
  eleicoes: { ...ELEICOES_PADRAO },
  ultimaConsultaOk: null,
};

// ---------- utilidades ----------
function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const f of filhos) if (f != null) n.append(f);
  return n;
}
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function marcarAtualizado(node) {
  node.classList.remove("atualizado");
  void node.offsetWidth;
  node.classList.add("atualizado");
}
function setTexto(node, texto) {
  if (node.textContent !== texto) {
    node.textContent = texto;
    marcarAtualizado(node);
  }
}
const horaBrasilia = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const iniciais = (nome) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("");
const pctTexto = (n) => `${n.toFixed(2).replace(".", ",")}%`;
const facilitar = (t) => 1 - (1 - t) ** 3;

// Contador animado: interpola até o valor oficial e termina SEMPRE no texto oficial.
function contar(node, alvo, formatar, textoFinal) {
  const de = Number(node.dataset.valor ?? NaN);
  node.dataset.valor = String(alvo);
  cancelAnimationFrame(Number(node.dataset.raf || 0));
  if (reduzirMovimento || !Number.isFinite(de) || de === alvo) { setTexto(node, textoFinal); return; }
  const inicio = performance.now();
  const dur = 1100;
  const passo = (agora) => {
    const t = Math.min(1, (agora - inicio) / dur);
    if (t < 1) {
      node.textContent = formatar(de + (alvo - de) * facilitar(t));
      node.dataset.raf = String(requestAnimationFrame(passo));
    } else {
      node.textContent = textoFinal;
      marcarAtualizado(node);
    }
  };
  node.dataset.raf = String(requestAnimationFrame(passo));
}

function imagemCandidato(c, classe) {
  const caixa = el("div", { class: classe, "aria-hidden": "true" });
  const src = c.foto || fotoCandidato(c, null);
  if (src) {
    const img = el("img", { src, alt: "", decoding: "async", referrerpolicy: "no-referrer", width: "160", height: "160" });
    img.addEventListener("error", () => { caixa.textContent = iniciais(c.nome); });
    caixa.append(img);
  } else caixa.textContent = iniciais(c.nome);
  return caixa;
}

// ---------- busca de dados ----------
async function buscarApi(turno) {
  const resp = await fetch(`/api/resultados?turno=${turno}`, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`API respondeu HTTP ${resp.status}`);
  const dados = await resp.json();
  if (!dados || !dados.escopos || !dados.eleicao) throw new Error("resposta da API em formato inesperado");
  return dados;
}

// Plano B: se a rota do servidor falhar em produção, lê os mesmos arquivos
// oficiais direto do TSE (que permite CORS). Não é usado em ambiente local.
async function buscarDireto(turno) {
  const eleicao = estado.eleicoes[turno];
  const cfg = { base: FONTE_OFICIAL, ambiente: "oficial", ciclo: "ele2026", eleicao, cargo: 1 };
  const consultadoEm = Date.now();
  const pares = await Promise.all(ABRANGENCIAS.map(async (uf) => {
    try {
      const r = await fetch(urlArquivo(cfg, uf), { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const dados = lerArquivo(await r.json(), { uf, eleicao });
      for (const c of dados.candidatos) c.foto = fotoCandidato(c, cfg);
      return [uf, { dados, erro: null }];
    } catch (e) {
      return [uf, { dados: null, erro: { codigo: "DIRETO", mensagem: String(e.message || e) } }];
    }
  }));
  const lidos = pares.filter(([, p]) => p.dados).length;
  const snap = completarComRegistro({ turno: Number(turno), eleicao, consultadoEm, arquivosLidos: lidos, arquivosTotal: ABRANGENCIAS.length,
    fonte: { nome: "TSE (leitura direta)", base: FONTE_OFICIAL }, escopos: Object.fromEntries(pares) }, REGISTRO_1T);
  if (!Object.values(snap.escopos).some((e) => e.dados)) throw new Error("fonte oficial indisponível");
  return snap;
}

async function atualizar() {
  clearTimeout(estado.timer);
  const turno = estado.turno;
  const seq = ++estado.seqEnviada;
  let dados = null;
  let erro = null;
  try {
    dados = await buscarApi(turno);
  } catch (e) {
    erro = e;
    if (!ambienteLocal) {
      try { dados = await buscarDireto(turno); erro = null; } catch (e2) { erro = e2; }
    }
  }
  // Descarta respostas atrasadas (outro turno ou requisição mais antiga já aplicada).
  if (turno !== estado.turno || seq < estado.seqAplicada) return;
  if (dados) {
    estado.seqAplicada = seq;
    estado.falhas = 0;
    estado.eleicoes[turno] = dados.eleicao;
    estado.snapshot = mesclar(estado.snapshot, dados);
    // "Última consulta bem-sucedida" só avança quando algum arquivo oficial foi lido de fato.
    if (dados.arquivosLidos > 0) estado.ultimaConsultaOk = dados.consultadoEm;
    render();
    const semResposta = dados.arquivosLidos === 0 && Object.values(dados.escopos).some((e) => e.erro && e.erro.codigo !== "NAO_PUBLICADO");
    if (snapshotEncerrado()) setVivo("final", "Resultado final");
    else if (semResposta) setVivo("erro", "Fonte oficial sem resposta");
    else setVivo("ok", Object.values(estado.snapshot.escopos).some((e) => e.dados?.status === "parcial") ? "Ao vivo" : "Conectado · aguardando TSE");
    $("mensagem").textContent = mensagemFalhasParciais(estado.snapshot);
  } else {
    estado.falhas += 1;
    setVivo("erro", "Sem conexão com a fonte");
    $("mensagem").textContent = estado.snapshot
      ? `Não foi possível atualizar agora (${erro.message}). Exibindo a última leitura válida; nova tentativa automática em breve.`
      : `Não foi possível obter os dados oficiais (${erro.message}). Nova tentativa automática em breve. Nenhum número é exibido sem dado oficial.`;
    if (!estado.snapshot) render();
  }
  agendar();
}

function agendar() {
  clearTimeout(estado.timer);
  if (document.hidden) return; // retoma ao voltar para a aba
  let espera = INTERVALO_MS;
  if (estado.falhas) espera = Math.min(INTERVALO_MS * 2 ** (estado.falhas - 1), INTERVALO_MAX_ERRO_MS);
  else if (snapshotEncerrado()) espera = INTERVALO_ENCERRADO_MS;
  estado.timer = setTimeout(atualizar, espera);
}

function snapshotEncerrado() {
  const itens = Object.values(estado.snapshot?.escopos || {});
  return itens.length > 0 && itens.every((i) => i.dados?.status === "final");
}

function mensagemFalhasParciais(snap) {
  const falhos = Object.entries(snap.escopos).filter(([, i]) => i.erro && i.erro.codigo !== "NAO_PUBLICADO");
  if (!falhos.length) return "";
  const lista = (itens) => `${itens.slice(0, 4).map(([uf]) => NOMES[uf]).join(", ")}${itens.length > 4 ? "…" : ""}`;
  const comLeitura = falhos.filter(([, i]) => i.dados);
  const semLeitura = falhos.filter(([, i]) => !i.dados);
  const partes = [];
  if (comLeitura.length) partes.push(`Falha ao atualizar ${comLeitura.length} recorte(s) (${lista(comLeitura)}); exibindo a última leitura válida.`);
  if (semLeitura.length) partes.push(`A fonte oficial não respondeu para ${semLeitura.length} recorte(s) (${lista(semLeitura)}); nova tentativa automática em breve.`);
  return partes.join(" ");
}

function setVivo(est, texto) {
  $("indicador-vivo").dataset.estado = est;
  $("indicador-texto").textContent = texto;
}

// ---------- renderização ----------
function render() {
  const snap = estado.snapshot;
  const item = snap?.escopos?.[estado.uf] || null;
  const dados = item?.dados || null;
  const referencia = candidatosReferencia(snap?.escopos?.br?.dados);
  renderStatus(item, snap);
  renderCandidatos(dados, referencia, item);
  renderIndicadores(dados);
  renderMapa(referencia);
  renderTabela(referencia);
  renderLegenda(referencia);
}

function renderStatus(item, snap) {
  const dados = item?.dados;
  const selo = $("selo-status");
  const status = dados?.status || "aguardando";
  selo.dataset.status = status;
  selo.textContent = status === "final" ? "Resultado final" : status === "parcial" ? "Apuração parcial" : "Aguardando";
  const nome = NOMES[estado.uf];
  if (!dados) {
    setTexto($("status-secoes"), `${nome}: aguardando divulgação dos resultados oficiais`);
  } else if (status === "aguardando") {
    setTexto($("status-secoes"), `${nome}: arquivo oficial publicado, apuração ainda não iniciada`);
  } else if (dados.secoes.totalizadas == null) {
    setTexto($("status-secoes"), `${nome}: ${formatarPct(dados.secoes.pct)} das seções totalizadas`);
  } else {
    setTexto($("status-secoes"), `${nome}: ${formatarPct(dados.secoes.pct)} das seções totalizadas (${formatarVotos(dados.secoes.totalizadas)} de ${formatarVotos(dados.secoes.total)})`);
  }
  const br = snap?.escopos?.br?.dados;
  $("barra-progresso").style.width = br?.secoes?.pctNum != null && br.status !== "aguardando" ? `${br.secoes.pctNum}%` : "0";
  $("hora-referencia").textContent = dados?.dg ? `${dados.dg} ${dados.hg} (Brasília)` : "—";
  $("hora-consulta").textContent = estado.ultimaConsultaOk ? horaBrasilia.format(new Date(estado.ultimaConsultaOk)) : "—";
}

function slotDe(numero, referencia) {
  const i = referencia.indexOf(numero);
  return i === 0 ? "a" : i === 1 ? "b" : "outro";
}

function renderCandidatos(dados, referencia, item) {
  const lista = $("candidatos");
  $("escopo-nome").textContent = NOMES[estado.uf];
  $("voltar-brasil").hidden = estado.uf === "br";
  const avisos = $("avisos-dados");
  const msgs = [...(dados?.avisos || [])];
  if (item?.desatualizado) msgs.unshift("Este recorte não pôde ser atualizado na última consulta; exibindo a última leitura válida");
  if (dados?.origem === "registro") msgs.push("Exibindo os dois candidatos que foram ao 2º turno, conforme a totalização final do TSE. A lista completa aparece quando a leitura direta do arquivo do 1º turno responder");
  avisos.hidden = !msgs.length;
  avisos.textContent = msgs.length ? `${msgs.join(". ")}.` : "";

  if (!dados) {
    lista.replaceChildren(el("li", { class: "vazio" },
      el("strong", { text: "Aguardando divulgação dos resultados oficiais" }),
      "Os candidatos e números aparecem aqui assim que o TSE publicar o arquivo oficial deste recorte. Nenhum valor é estimado."));
    return;
  }
  const iniciada = dados.status !== "aguardando";
  const existentes = new Map([...lista.querySelectorAll(".candidato")].map((n) => [n.dataset.numero, n]));
  const nos = dados.candidatos.map((c, i) => {
    const no = existentes.get(c.numero) || criarCandidato(c, i);
    no.dataset.slot = slotDe(c.numero, referencia);
    no.classList.toggle("lider", iniciada && i === 0 && c.votos > (dados.candidatos[1]?.votos ?? -1));
    const nums = no.querySelector(".cand-numeros");
    if (iniciada) {
      if (!nums.querySelector(".cand-pct")) nums.replaceChildren(el("span", { class: "cand-pct" }), el("span", { class: "cand-votos" }));
      contar(nums.querySelector(".cand-pct"), c.pctNum ?? 0, pctTexto, formatarPct(c.pct));
      contar(nums.querySelector(".cand-votos"), c.votos, (v) => `${formatarVotos(Math.round(v))} votos`, `${formatarVotos(c.votos)} votos`);
      no.querySelector(".cand-trilho span").style.width = `${c.pctNum ?? 0}%`;
      no.querySelector(".foto").style.setProperty("--p", String(c.pctNum ?? 0));
    } else {
      nums.replaceChildren(el("span", { class: "cand-aguardando", text: "Aguardando divulgação dos resultados oficiais" }));
      no.querySelector(".cand-trilho span").style.width = "0";
      no.querySelector(".foto").style.setProperty("--p", "0");
    }
    const etiquetas = no.querySelector(".etiquetas");
    etiquetas.replaceChildren();
    if (no.classList.contains("lider") && dados.status === "parcial") etiquetas.append(el("span", { class: "etiqueta lidera", text: "Lidera" }));
    if (iniciada && /eleit|turno/i.test(c.situacao) && !/n[aã]o eleit/i.test(c.situacao)) etiquetas.append(el("span", { class: "etiqueta", text: c.situacao }));
    no.setAttribute("aria-label", iniciada
      ? `${c.nome}, ${c.partido}: ${formatarPct(c.pct)} dos votos válidos, ${formatarVotos(c.votos)} votos`
      : `${c.nome}, ${c.partido}: aguardando resultados`);
    return no;
  });
  // Reordena só se a posição mudou (evita reiniciar as animações a cada consulta).
  const atual = [...lista.children];
  if (nos.length !== atual.length || nos.some((n, i) => n !== atual[i])) lista.replaceChildren(...nos);
}

function criarCandidato(c, ordem) {
  const foto = el("div", { class: "foto" }, imagemCandidato(c, "foto-interna"));
  return el("li", { class: "candidato", "data-numero": c.numero, style: `--ordem:${ordem}` },
    foto,
    el("div", { class: "cand-topo" },
      el("p", { class: "cand-nome", text: c.nome }),
      el("div", { class: "cand-partido", text: [c.partido, c.numero].filter(Boolean).join(" · ") }),
      el("div", { class: "etiquetas" })),
    el("div", { class: "cand-numeros" }),
    el("div", { class: "cand-trilho" }, el("span")));
}

function renderIndicadores(dados) {
  $("indicadores-escopo").textContent = `— ${NOMES[estado.uf]}`;
  const ok = dados && dados.status !== "aguardando";
  const num = (t) => (t == null ? null : Number(String(t).replace(",", ".")));
  const v = dados?.votos || {};
  const linhas = [
    ["Seções totalizadas", ok ? formatarPct(dados.secoes.pct) : "—", ok && dados.secoes.totalizadas != null ? `${formatarVotos(dados.secoes.totalizadas)} de ${formatarVotos(dados.secoes.total)}` : ok ? "" : "aguardando", ok ? dados.secoes.pctNum : 0],
    ["Votos válidos", ok ? formatarVotos(v.validos) : "—", "", null],
    ["Brancos", ok ? formatarPct(v.pctBrancos) : "—", ok && v.brancos != null ? `${formatarVotos(v.brancos)} votos` : "", ok ? num(v.pctBrancos) : 0],
    ["Nulos", ok ? formatarPct(v.pctNulos) : "—", ok && v.nulos != null ? `${formatarVotos(v.nulos)} votos` : "", ok ? num(v.pctNulos) : 0],
    ["Abstenção", ok ? formatarPct(v.pctAbstencao) : "—", ok && v.abstencao != null ? `${formatarVotos(v.abstencao)} eleitores` : "", ok ? num(v.pctAbstencao) : 0],
  ];
  const dl = $("indicadores");
  if (dl.children.length !== linhas.length) {
    dl.replaceChildren(...linhas.map(() => el("div", { class: "indicador" },
      el("dt"), el("dd", {}, el("span", { class: "pct" }), el("span", { class: "abs" }), el("span", { class: "trilho" }, el("span"))))));
  }
  linhas.forEach(([rotulo, valor, abs, largura], i) => {
    const n = dl.children[i];
    n.querySelector("dt").textContent = rotulo;
    setTexto(n.querySelector(".pct"), valor);
    n.querySelector(".abs").textContent = abs;
    const trilho = n.querySelector(".trilho");
    trilho.hidden = largura == null;
    trilho.firstChild.style.width = `${Number.isFinite(largura) ? largura : 0}%`;
  });
  $("nota-indicadores").textContent = dados?.origem === "registro"
    ? "Brancos, nulos e abstenção aparecem quando a leitura direta do arquivo oficial do TSE responder."
    : "Percentuais de brancos, nulos e abstenção conforme publicados pelo TSE.";
}

// ---------- resumo do 1º turno (dado final, oficial) ----------
function renderResumo1T() {
  const secao = $("resumo-1t");
  secao.hidden = estado.turno !== "2";
  if (secao.hidden || secao.dataset.pronto) return;
  const br = dadosDoRegistro(REGISTRO_1T, "br");
  if (!br) { secao.hidden = true; return; }
  const [esq, dir] = br.candidatos; // ordenados por votos
  const ref = candidatosReferencia(br);
  const cor = (c) => `var(--${slotDe(c.numero, ref)}-3)`;
  const foto = (c) => {
    const img = el("img", { src: c.foto, alt: "", width: "112", height: "112", decoding: "async" });
    img.addEventListener("error", () => img.replaceWith(el("span", { class: "duelo-sem-foto", text: iniciais(c.nome) })));
    return img;
  };
  const lado = (c) => el("div", { class: "duelo-lado", style: `--cor-lado:${cor(c)}` },
    foto(c),
    el("div", { class: "duelo-info" },
      el("div", { class: "duelo-nome", text: c.nome }),
      el("div", { class: "duelo-partido", text: `${c.partido} · ${c.numero}` }),
      el("div", { class: "duelo-pct", text: formatarPct(c.pct) }),
      el("div", { class: "duelo-votos", text: `${formatarVotos(c.votos)} votos` })));
  const barra = el("div", { class: "duelo-barra", style: `--cor-esq:${cor(esq)};--cor-dir:${cor(dir)}`, role: "img",
    "aria-label": `${esq.nome} ${formatarPct(esq.pct)} contra ${dir.nome} ${formatarPct(dir.pct)} dos votos válidos` }, el("span"), el("span"));
  $("resumo-duelo").replaceChildren(
    el("div", { class: "duelo-lados" }, lado(esq), lado(dir)),
    barra,
    el("p", { class: "duelo-nota", text: "Percentual sobre votos válidos. Os dois mais votados disputam o 2º turno em 25/10/2026." }));
  $("resumo-fonte").textContent = `TSE · ${br.dg} ${br.hg.slice(0, 5)} · ${formatarPct(br.secoes.pct)} das seções`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const [a, b] = barra.children;
    a.style.width = `${esq.pctNum}%`;
    b.style.width = `${dir.pctNum}%`;
  }));
  secao.dataset.pronto = "1";
}

// ---------- mapa ----------
function preferenciaModo() {
  const q = params.get("mapa");
  if (q === "2d" || q === "3d") return q;
  try { const s = localStorage.getItem("bav:mapa"); if (s === "2d" || s === "3d") return s; } catch { /* sem armazenamento */ }
  return reduzirMovimento ? "2d" : "3d";
}

async function carregarMapa() {
  const resp = await fetch("/data/brasil-uf.json");
  if (!resp.ok) throw new Error("mapa indisponível");
  estado.geo = await resp.json();
  await definirModoMapa(preferenciaModo(), false);
}

async function definirModoMapa(modo, salvar = true) {
  const palco = $("mapa-palco");
  if (modo === "3d") {
    try {
      const mod = await import("./mapa3d.js");
      if (!mod.webglDisponivel()) throw new Error("WebGL indisponível");
      estado.mapa3d?.destruir();
      palco.replaceChildren();
      palco.dataset.modo = "3d";
      estado.mapa3d = mod.criarMapa3D(palco, estado.geo, {
        aoSelecionar: (uf) => selecionar(uf),
        aoPassar: (uf, ev) => (uf ? mostrarTooltip(ev, uf) : esconderTooltip()),
        reduzirMovimento,
      });
      estado.modoMapa = "3d";
    } catch {
      modo = "2d"; // sem WebGL ou sem acesso à biblioteca 3D: mapa 2D completo
    }
  }
  if (modo === "2d") {
    estado.mapa3d?.destruir();
    estado.mapa3d = null;
    palco.dataset.modo = "2d";
    montarMapa2D(palco);
    estado.modoMapa = "2d";
  }
  document.querySelectorAll(".alternar-mapa button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.modo === estado.modoMapa)));
  $("dica-mapa").textContent = estado.modoMapa === "3d"
    ? "Toque ou clique em um estado. No mapa 2D, os estados também podem ser escolhidos pelo teclado."
    : "Toque, clique ou use Tab + Enter para escolher um estado.";
  if (salvar) { try { localStorage.setItem("bav:mapa", estado.modoMapa); } catch { /* sem armazenamento */ } }
  assinaturaMapa.clear();
  render();
}

function montarMapa2D(palco) {
  const raiz = svg("svg", { viewBox: estado.geo.viewBox, role: "group", "aria-label": "Mapa do Brasil por unidade da federação" });
  const defs = svg("defs");
  for (const e of estado.geo.estados) defs.append(svg("path", { id: `geo-${e.uf}`, d: e.d }));
  raiz.append(defs);
  const prof = svg("g", { class: "profundidade", "aria-hidden": "true" });
  [[10, ""], [6, "camada-2"], [3, "camada-1"]].forEach(([dy, classe]) => {
    const g = svg("g", { transform: `translate(0 ${dy})`, class: classe });
    for (const e of estado.geo.estados) g.append(svg("use", { href: `#geo-${e.uf}` }));
    prof.append(g);
  });
  raiz.append(prof);
  const camada = svg("g", { class: "estados" });
  const rotulos = svg("g", { "aria-hidden": "true" });
  for (const e of estado.geo.estados) {
    const g = svg("g", { class: "uf c-sem-dados", "data-uf": e.uf, tabindex: "0", role: "button", "aria-pressed": "false" });
    g.append(svg("use", { href: `#geo-${e.uf}` }));
    g.addEventListener("click", () => selecionar(estado.uf === e.uf ? "br" : e.uf));
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selecionar(estado.uf === e.uf ? "br" : e.uf); }
    });
    g.addEventListener("pointermove", (ev) => mostrarTooltip(ev, e.uf));
    g.addEventListener("pointerleave", esconderTooltip);
    camada.append(g);
    const t = svg("text", { x: e.cx, y: e.cy + 4, "text-anchor": "middle", class: "rotulo-uf", "data-rotulo": e.uf });
    t.textContent = e.uf.toUpperCase();
    rotulos.append(t);
  }
  raiz.append(camada, rotulos);
  palco.replaceChildren(raiz);
}

const assinaturaMapa = new Map();
function renderMapa(referencia) {
  if (!estado.geo || !estado.modoMapa) return;
  const css = getComputedStyle(document.documentElement);
  const cores = new Map();
  const pulsar = new Set();
  for (const e of estado.geo.estados) {
    const uf = e.uf;
    const dados = estado.snapshot?.escopos?.[uf]?.dados;
    const cor = corEstado(dados, referencia);
    const assinatura = `${cor.classe}|${dados?.dataRef}|${dados?.secoes?.totalizadas}`;
    const antes = assinaturaMapa.get(uf);
    if (antes && antes !== assinatura) pulsar.add(uf);
    assinaturaMapa.set(uf, assinatura);
    cores.set(uf, css.getPropertyValue(cor.classe === "empate" ? "--empate" : `--${cor.classe}`).trim() || "#161618");
    const g = document.querySelector(`.uf[data-uf="${uf}"]`);
    if (g) {
      g.setAttribute("class", `uf c-${cor.classe}`);
      if (pulsar.has(uf)) { g.classList.add("pulso"); setTimeout(() => g.classList.remove("pulso"), 1300); }
      g.setAttribute("aria-pressed", String(estado.uf === uf));
      g.setAttribute("aria-label", descreverUf(uf, dados, cor));
      document.querySelector(`[data-rotulo="${uf}"]`)?.classList.toggle("escuro", cor.classe === "b-3");
    }
  }
  document.querySelector(".estados")?.classList.toggle("com-selecao", estado.uf !== "br");
  if (estado.mapa3d) {
    const dadosSel = estado.snapshot?.escopos?.[estado.uf]?.dados;
    const lider = dadosSel && dadosSel.status !== "aguardando" ? dadosSel.candidatos[0] : null;
    const rot = estado.uf === "br" ? "" : `${NOMES[estado.uf]}${lider ? ` · ${lider.nome.split(" ")[0]} ${formatarPct(lider.pct)}` : ""}`;
    estado.mapa3d.atualizar(cores, estado.uf, rot, pulsar);
  }
}

function descreverUf(uf, dados, cor) {
  const nome = NOMES[uf];
  if (!dados) return `${nome}: aguardando divulgação dos resultados oficiais`;
  if (dados.status === "aguardando") return `${nome}: apuração não iniciada`;
  const [p, s] = dados.candidatos;
  const lider = cor.classe === "empate" ? `disputa acirrada, ${p.nome} à frente` : `${p.nome} lidera`;
  return `${nome}: ${lider} com ${formatarPct(p.pct)}${s ? `, ${s.nome} tem ${formatarPct(s.pct)}` : ""}; ${formatarPct(dados.secoes.pct)} das seções totalizadas`;
}

function mostrarTooltip(ev, uf) {
  if (!ev || ev.pointerType === "touch") return;
  const t = $("tooltip");
  const dados = estado.snapshot?.escopos?.[uf]?.dados;
  t.replaceChildren(el("strong", { text: NOMES[uf] }));
  if (!dados || dados.status === "aguardando") t.append("Aguardando resultados oficiais");
  else {
    for (const c of dados.candidatos.slice(0, 2)) t.append(el("div", { text: `${c.nome}: ${formatarPct(c.pct)}` }));
    t.append(el("div", { class: "num", text: `Seções: ${formatarPct(dados.secoes.pct)}` }));
  }
  t.hidden = false;
  const x = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8);
  t.style.left = `${x}px`;
  t.style.top = `${ev.clientY + 14}px`;
}
function esconderTooltip() { $("tooltip").hidden = true; }

function renderLegenda(referencia) {
  const br = estado.snapshot?.escopos?.br?.dados;
  const nomeDe = (num) => br?.candidatos.find((c) => c.numero === num)?.nome || "—";
  const grupos = [];
  const escala = (prefixo) => el("span", { class: "legenda-escala" },
    ...[1, 2, 3].map((f) => el("span", { class: "amostra", style: `background: var(--${prefixo}-${f})` })));
  if (referencia.length && br?.status !== "aguardando") {
    referencia.forEach((num, i) => grupos.push(el("span", { class: "legenda-grupo" }, escala(i === 0 ? "a" : "b"), document.createTextNode(`${nomeDe(num)} lidera`))));
    if (br?.candidatos.length > 2) grupos.push(el("span", { class: "legenda-grupo" }, escala("outro"), document.createTextNode("Outro candidato lidera")));
    grupos.push(el("span", { class: "legenda-grupo" }, el("span", { class: "amostra", style: "background: var(--empate)" }), document.createTextNode("Diferença menor que 1 p.p.")));
  }
  grupos.push(el("span", { class: "legenda-grupo" }, el("span", { class: "amostra", style: "background: var(--sem-dados); border-color:#2b2b30" }), document.createTextNode("Aguardando dados")));
  grupos.push(el("p", { class: "legenda-nota", text: "Intensidade da cor: diferença entre 1º e 2º colocados no estado. Clara: 1 a 10 p.p.; média: 10 a 20 p.p.; forte: 20 p.p. ou mais. Os mesmos dados estão em texto na tabela abaixo." }));
  $("legenda").replaceChildren(...grupos);
}

// ---------- tabela (alternativa textual) ----------
function renderTabela(referencia) {
  const corpo = $("tabela-corpo");
  const linhas = ABRANGENCIAS.filter((uf) => uf !== "br").map((uf) => {
    const dados = estado.snapshot?.escopos?.[uf]?.dados;
    const iniciada = dados && dados.status !== "aguardando";
    const [p, s] = iniciada ? dados.candidatos : [];
    const cel = (c) => {
      if (!c) return el("td", { text: iniciada ? "—" : "Aguardando" });
      const slot = slotDe(c.numero, referencia);
      return el("td", {}, el("span", { class: "marcador", style: `background: var(--${slot}-3)`, "aria-hidden": "true" }),
        document.createTextNode(`${c.nome} `), el("span", { class: "num", text: formatarPct(c.pct) }));
    };
    return el("tr", { "aria-current": estado.uf === uf ? "true" : null },
      el("td", {}, el("button", { type: "button", class: "link-uf", "data-uf": uf, text: NOMES[uf] })),
      cel(p), cel(s),
      el("td", { class: "num", text: p && s && p.pctNum != null && s.pctNum != null ? `${(p.pctNum - s.pctNum).toFixed(2).replace(".", ",")} p.p.` : "—" }),
      el("td", { class: "num", text: dados ? formatarPct(dados.secoes.pct) : "—" }));
  });
  corpo.replaceChildren(...linhas);
}

// ---------- interação ----------
function selecionar(uf) {
  estado.uf = uf;
  $("seletor-uf").value = uf;
  const url = new URL(location.href);
  if (uf === "br") url.searchParams.delete("uf"); else url.searchParams.set("uf", uf);
  history.replaceState(null, "", url);
  render();
}

function trocarTurno(turno) {
  if (turno === estado.turno) return;
  estado.turno = turno;
  estado.snapshot = null;
  estado.ultimaConsultaOk = null;
  estado.falhas = 0;
  assinaturaMapa.clear();
  $("candidatos").replaceChildren();
  marcarTurno();
  const url = new URL(location.href);
  if (turno === "2") url.searchParams.delete("turno"); else url.searchParams.set("turno", turno);
  history.replaceState(null, "", url);
  setVivo("carregando", "Atualizando");
  renderResumo1T();
  render();
  atualizar();
}

function marcarTurno() {
  document.querySelector(".turnos").dataset.ativo = estado.turno === "1" ? "1" : "2";
  document.querySelectorAll(".turno").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.turno === estado.turno)));
}

function configurarCredito() {
  const box = $("credito");
  const handle = (box.dataset.instagram || "").replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return;
  const a = $("credito-instagram");
  a.href = `https://www.instagram.com/${handle}/`;
  $("credito-instagram-texto").textContent = `@${handle}`;
  a.hidden = false;
}

function iniciar() {
  const sel = $("seletor-uf");
  for (const uf of ABRANGENCIAS.filter((u) => u !== "br")) sel.append(el("option", { value: uf, text: NOMES[uf] }));
  sel.value = estado.uf;
  sel.addEventListener("change", () => selecionar(sel.value));
  $("voltar-brasil").addEventListener("click", () => selecionar("br"));
  $("tabela-corpo").addEventListener("click", (ev) => {
    const b = ev.target.closest(".link-uf");
    if (b) { selecionar(b.dataset.uf); $("painel-candidatos").focus(); }
  });
  marcarTurno();
  document.querySelectorAll(".turno").forEach((b) => b.addEventListener("click", () => trocarTurno(b.dataset.turno)));
  document.querySelectorAll(".alternar-mapa button").forEach((b) => b.addEventListener("click", () => {
    if (estado.geo && b.dataset.modo !== estado.modoMapa) definirModoMapa(b.dataset.modo);
  }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(estado.timer);
    else atualizar();
  });
  configurarCredito();
  renderResumo1T();
  carregarMapa().catch(() => { $("mapa-palco").textContent = "Não foi possível carregar o mapa. Os resultados por estado estão na tabela abaixo."; });
  render();
  atualizar();
}

// Exposto apenas para os testes automatizados conferirem o estado da página.
window.__bav = { estado, maisNovo };
iniciar();
