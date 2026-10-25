import {
  ABRANGENCIAS, FONTE_OFICIAL, NOMES, candidatosReferencia, corEstado, formatarPct, formatarVotos,
  lerArquivo, maisNovo, mesclar, urlArquivo, urlFoto,
} from "./core.js";

const params = new URLSearchParams(location.search);
const ambienteLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
// 30 s: casado com o cache de 20 s da rota e com o ritmo de publicação do TSE.
// ?intervalo=<ms> só é aceito localmente (testes automatizados).
const INTERVALO_MS = ambienteLocal && Number(params.get("intervalo")) >= 200 ? Number(params.get("intervalo")) : 30_000;
const INTERVALO_ENCERRADO_MS = 5 * 60_000;
const INTERVALO_MAX_ERRO_MS = 120_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const ELEICOES_PADRAO = { 1: "6257", 2: "6258" };

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
  eleicoes: { ...ELEICOES_PADRAO },
};

// ---------- utilidades de DOM ----------
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
function setTexto(node, texto) {
  if (node.textContent !== texto) {
    node.textContent = texto;
    node.classList.remove("atualizado");
    void node.offsetWidth;
    node.classList.add("atualizado");
  }
}
const horaBrasilia = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const iniciais = (nome) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("");

// ---------- busca de dados ----------
async function buscarApi(turno) {
  const resp = await fetch(`/api/resultados?turno=${turno}`, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`API respondeu HTTP ${resp.status}`);
  const dados = await resp.json();
  if (!dados || !dados.escopos || !dados.eleicao) throw new Error("resposta da API em formato inesperado");
  return dados;
}

// Plano B: se a rota do servidor falhar em produção, lê os mesmos arquivos
// oficiais direto do TSE (que permite CORS). Nunca usado em ambiente local de teste.
async function buscarDireto(turno) {
  const eleicao = estado.eleicoes[turno];
  const cfg = { base: FONTE_OFICIAL, ambiente: "oficial", ciclo: "ele2026", eleicao, cargo: 1 };
  const consultadoEm = Date.now();
  const pares = await Promise.all(ABRANGENCIAS.map(async (uf) => {
    try {
      const r = await fetch(urlArquivo(cfg, uf), { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const dados = lerArquivo(await r.json(), { uf, eleicao });
      for (const c of dados.candidatos) c.foto = urlFoto(cfg, c.sq);
      return [uf, { dados, erro: null }];
    } catch (e) {
      return [uf, { dados: null, erro: { codigo: "DIRETO", mensagem: String(e.message || e) } }];
    }
  }));
  const escopos = Object.fromEntries(pares);
  const lidos = pares.filter(([, p]) => p.dados).length;
  if (!lidos) throw new Error("fonte oficial indisponível");
  return { turno: Number(turno), eleicao, consultadoEm, arquivosLidos: lidos, arquivosTotal: ABRANGENCIAS.length,
    fonte: { nome: "TSE (leitura direta)", base: FONTE_OFICIAL, teste: false }, escopos };
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
    render();
    setVivo("ok", dados.arquivosLidos ? "Ao vivo" : "Conectado · aguardando TSE");
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
  const nomes = falhos.slice(0, 4).map(([uf]) => NOMES[uf]).join(", ");
  return `Falha ao atualizar ${falhos.length} arquivo(s) oficial(is) (${nomes}${falhos.length > 4 ? "…" : ""}). Exibindo a última leitura válida desses recortes.`;
}

function setVivo(est, texto) {
  $("indicador-vivo").dataset.estado = est;
  $("indicador-texto").textContent = texto;
}

// ---------- renderização ----------
function escopoAtual() {
  return estado.snapshot?.escopos?.[estado.uf] || null;
}

function render() {
  const snap = estado.snapshot;
  $("aviso-teste").hidden = !snap?.fonte?.teste;
  const item = escopoAtual();
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
    setTexto($("status-secoes"), `${nome}: arquivo oficial publicado, apuração ainda não iniciada (0 seções totalizadas)`);
  } else {
    setTexto($("status-secoes"), `${nome}: ${formatarPct(dados.secoes.pct)} das seções totalizadas (${formatarVotos(dados.secoes.totalizadas)} de ${formatarVotos(dados.secoes.total)})`);
  }
  const br = snap?.escopos?.br?.dados;
  $("barra-progresso").style.width = br?.secoes?.pctNum != null ? `${br.secoes.pctNum}%` : "0";
  $("hora-referencia").textContent = dados?.dg ? `${dados.dg} ${dados.hg} (Brasília)` : "—";
  $("hora-consulta").textContent = snap?.consultadoEm ? horaBrasilia.format(new Date(snap.consultadoEm)) : "—";
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
  if (item?.desatualizado) msgs.unshift("Este recorte não pôde ser atualizado na última consulta; exibindo a última leitura válida.");
  avisos.hidden = !msgs.length;
  avisos.textContent = msgs.length ? `Conferência dos dados: ${msgs.join("; ")}.` : "";

  if (!dados) {
    lista.replaceChildren(el("li", { class: "vazio" },
      el("strong", { text: "Aguardando divulgação dos resultados oficiais" }),
      "Os candidatos e números aparecem aqui assim que o TSE publicar o arquivo oficial deste recorte. Nenhum valor é estimado."));
    return;
  }
  const iniciada = dados.status !== "aguardando";
  const existentes = new Map([...lista.querySelectorAll(".candidato")].map((n) => [n.dataset.numero, n]));
  const nos = dados.candidatos.map((c) => {
    const no = existentes.get(c.numero) || criarCandidato(c);
    no.dataset.slot = slotDe(c.numero, referencia);
    const nums = no.querySelector(".cand-numeros");
    if (iniciada) {
      if (!nums.querySelector(".cand-pct")) nums.replaceChildren(el("span", { class: "cand-pct" }), el("span", { class: "cand-votos" }));
      setTexto(nums.querySelector(".cand-pct"), formatarPct(c.pct));
      setTexto(nums.querySelector(".cand-votos"), `${formatarVotos(c.votos)} votos`);
      no.querySelector(".cand-trilho span").style.width = `${c.pctNum ?? 0}%`;
    } else {
      nums.replaceChildren(el("span", { class: "cand-aguardando", text: "Aguardando divulgação dos resultados oficiais" }));
      no.querySelector(".cand-trilho span").style.width = "0";
    }
    const sit = no.querySelector(".cand-situacao");
    const mostrarSit = iniciada && /eleit|turno/i.test(c.situacao) && !/n[aã]o eleit/i.test(c.situacao);
    sit.hidden = !mostrarSit;
    sit.textContent = mostrarSit ? c.situacao : "";
    no.setAttribute("aria-label", iniciada
      ? `${c.nome}, ${c.partido}: ${formatarPct(c.pct)} dos votos válidos, ${formatarVotos(c.votos)} votos`
      : `${c.nome}, ${c.partido}: aguardando resultados`);
    return no;
  });
  lista.replaceChildren(...nos);
}

function criarCandidato(c) {
  const foto = el("div", { class: "foto", "aria-hidden": "true" });
  if (c.foto) {
    const img = el("img", { src: c.foto, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => { foto.textContent = iniciais(c.nome); });
    foto.append(img);
  } else foto.textContent = iniciais(c.nome);
  return el("li", { class: "candidato", "data-numero": c.numero },
    foto,
    el("div", {},
      el("p", { class: "cand-nome" }, document.createTextNode(c.nome), el("span", { class: "cand-situacao", hidden: true })),
      el("div", { class: "cand-partido", text: `${c.partido} · ${c.numero}` })),
    el("div", { class: "cand-numeros" }),
    el("div", { class: "cand-trilho" }, el("span")));
}

function renderIndicadores(dados) {
  $("indicadores-escopo").textContent = `— ${NOMES[estado.uf]}`;
  const ok = dados && dados.status !== "aguardando";
  const linhas = [
    ["Seções totalizadas", ok ? formatarPct(dados.secoes.pct) : "—", ok ? `${formatarVotos(dados.secoes.totalizadas)} de ${formatarVotos(dados.secoes.total)}` : "aguardando", ok ? dados.secoes.pctNum : 0],
    ["Votos válidos", ok ? formatarVotos(dados.votos.validos) : "—", "", null],
    ["Brancos", ok ? formatarPct(dados.votos.pctBrancos) : "—", ok ? `${formatarVotos(dados.votos.brancos)} votos` : "", ok ? Number(String(dados.votos.pctBrancos).replace(",", ".")) : 0],
    ["Nulos", ok ? formatarPct(dados.votos.pctNulos) : "—", ok ? `${formatarVotos(dados.votos.nulos)} votos` : "", ok ? Number(String(dados.votos.pctNulos).replace(",", ".")) : 0],
    ["Abstenção", ok ? formatarPct(dados.votos.pctAbstencao) : "—", ok ? `${formatarVotos(dados.votos.abstencao)} eleitores` : "", ok ? Number(String(dados.votos.pctAbstencao).replace(",", ".")) : 0],
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
}

// ---------- mapa ----------
async function carregarMapa() {
  const resp = await fetch("/data/brasil-uf.json");
  if (!resp.ok) throw new Error("mapa indisponível");
  estado.geo = await resp.json();
  const palco = $("mapa-palco");
  const raiz = svg("svg", { viewBox: estado.geo.viewBox, role: "group", "aria-label": "Mapa do Brasil por unidade da federação" });
  const defs = svg("defs");
  const hach = svg("pattern", { id: "hachura-empate", width: "6", height: "6", patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  hach.append(svg("rect", { width: "6", height: "6", fill: "#2a2a2e" }), svg("line", { x1: "0", y1: "0", x2: "0", y2: "6", stroke: "#e3121b", "stroke-width": "2" }));
  defs.append(hach);
  for (const e of estado.geo.estados) defs.append(svg("path", { id: `geo-${e.uf}`, d: e.d }));
  raiz.append(defs);

  // Profundidade: cópias deslocadas das mesmas geometrias, sem custo de geometria extra.
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
  if (!estado.geo) return;
  for (const g of document.querySelectorAll(".uf")) {
    const uf = g.dataset.uf;
    const item = estado.snapshot?.escopos?.[uf];
    const dados = item?.dados;
    const cor = corEstado(dados, referencia);
    const classe = `uf c-${cor.classe}`;
    const assinatura = `${cor.classe}|${dados?.dataRef}|${dados?.secoes?.totalizadas}`;
    const antes = assinaturaMapa.get(uf);
    g.setAttribute("class", classe);
    if (antes && antes !== assinatura) { g.classList.add("pulso"); setTimeout(() => g.classList.remove("pulso"), 1300); }
    assinaturaMapa.set(uf, assinatura);
    g.setAttribute("aria-pressed", String(estado.uf === uf));
    g.setAttribute("aria-label", descreverUf(uf, dados, cor));
    const rot = document.querySelector(`[data-rotulo="${uf}"]`);
    if (rot) rot.classList.toggle("escuro", /^b-3$/.test(cor.classe));
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
  if (ev.pointerType === "touch") return;
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
  if (referencia.length) {
    referencia.forEach((num, i) => grupos.push(el("span", { class: "legenda-grupo" }, escala(i === 0 ? "a" : "b"), document.createTextNode(`${nomeDe(num)} lidera`))));
    if (br?.candidatos.length > 2) grupos.push(el("span", { class: "legenda-grupo" }, escala("outro"), document.createTextNode("Outro candidato lidera")));
  }
  grupos.push(el("span", { class: "legenda-grupo" }, el("span", { class: "amostra", style: "background: repeating-linear-gradient(45deg,#2a2a2e 0 3px,#e3121b 3px 5px)" }), document.createTextNode("Diferença menor que 1 p.p.")));
  grupos.push(el("span", { class: "legenda-grupo" }, el("span", { class: "amostra", style: "background: var(--sem-dados); border-color:#2b2b30" }), document.createTextNode("Aguardando dados")));
  grupos.push(el("p", { class: "legenda-nota", text: "Intensidade da cor: diferença entre 1º e 2º colocados no estado — clara: 1 a 10 p.p.; média: 10 a 20 p.p.; forte: 20 p.p. ou mais. Os mesmos dados estão em texto na tabela abaixo." }));
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
    const tr = el("tr", { "aria-current": estado.uf === uf ? "true" : null },
      el("td", {}, el("button", { type: "button", class: "link-uf", "data-uf": uf, text: NOMES[uf] })),
      cel(p), cel(s),
      el("td", { class: "num", text: p && s && p.pctNum != null && s.pctNum != null ? `${(p.pctNum - s.pctNum).toFixed(2).replace(".", ",")} p.p.` : "—" }),
      el("td", { class: "num", text: dados ? formatarPct(dados.secoes.pct) : "—" }));
    return tr;
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
  estado.falhas = 0;
  assinaturaMapa.clear();
  $("candidatos").replaceChildren();
  document.querySelectorAll(".turno").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.turno === turno)));
  const url = new URL(location.href);
  if (turno === "2") url.searchParams.delete("turno"); else url.searchParams.set("turno", turno);
  history.replaceState(null, "", url);
  setVivo("carregando", "Atualizando");
  render();
  atualizar();
}

function iniciar() {
  const sel = $("seletor-uf");
  for (const uf of ABRANGENCIAS.filter((u) => u !== "br")) sel.append(el("option", { value: uf, text: NOMES[uf] }));
  sel.value = estado.uf;
  sel.addEventListener("change", () => selecionar(sel.value));
  $("voltar-brasil").addEventListener("click", () => selecionar("br"));
  $("tabela-corpo").addEventListener("click", (ev) => {
    const b = ev.target.closest(".link-uf");
    if (b) { selecionar(b.dataset.uf); $("painel-candidatos").focus({ preventScroll: false }); }
  });
  document.querySelectorAll(".turno").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.turno === estado.turno));
    b.addEventListener("click", () => trocarTurno(b.dataset.turno));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(estado.timer);
    else atualizar();
  });
  carregarMapa().then(render).catch(() => { $("mapa-palco").textContent = "Não foi possível carregar o mapa. Os resultados por estado estão na tabela abaixo."; });
  render();
  atualizar();
}

// Exposto apenas para os testes automatizados conferirem a ordem das respostas.
window.__bav = { estado, maisNovo };
iniciar();
