// Camada de servidor: busca os arquivos oficiais do TSE uma única vez por
// intervalo e entrega a todos os visitantes (memória da instância + CDN da Vercel).
import { ABRANGENCIAS, FONTE_OFICIAL, ErroArquivo, lerArquivo, maisNovo, urlArquivo, urlFoto } from "../public/js/core.js";

// Códigos oficiais publicados em resultados.tse.jus.br/oficial/comum/config/ele-c.json:
// 6257 = Eleição Ordinária Federal 2026, 1º turno (04/10/2026); 6258 = 2º turno (25/10/2026).
export function lerConfig(env = process.env) {
  const usarFonteTeste = env.PERMITIR_FONTE_TESTE === "1" && !env.VERCEL && Boolean(env.TSE_BASE_URL);
  return {
    base: usarFonteTeste ? env.TSE_BASE_URL.replace(/\/$/, "") : FONTE_OFICIAL,
    teste: usarFonteTeste,
    ambiente: env.TSE_AMBIENTE || "oficial",
    ciclo: env.TSE_CICLO || "ele2026",
    cargo: 1,
    eleicoes: { 1: env.TSE_ELEICAO_1T || "6257", 2: env.TSE_ELEICAO_2T || "6258" },
    ttlMs: Number(env.CACHE_SEGUNDOS || 20) * 1000,
    timeoutMs: Number(env.TSE_TIMEOUT_MS || 6000),
  };
}

// Estado por instância (sobrevive entre invocações enquanto a função estiver aquecida).
const memoria = new Map(); // chave eleicao -> { em, promessa, snapshot }
const ultimaValida = new Map(); // chave eleicao:uf -> recorte

export function limparMemoria() {
  memoria.clear();
  ultimaValida.clear();
}

async function buscarJson(url, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "brasil-ao-vivo/1.0 (painel independente)" },
    });
    if (resp.status === 404 || resp.status === 403) {
      throw new ErroArquivo("NAO_PUBLICADO", `arquivo ainda não publicado (HTTP ${resp.status})`);
    }
    if (!resp.ok) throw new ErroArquivo("HTTP", `fonte respondeu HTTP ${resp.status}`);
    const texto = await resp.text();
    try {
      return JSON.parse(texto);
    } catch {
      throw new ErroArquivo("JSON", "resposta da fonte não é JSON válido");
    }
  } catch (err) {
    if (err instanceof ErroArquivo) throw err;
    if (err.name === "AbortError") throw new ErroArquivo("TIMEOUT", `sem resposta da fonte em ${timeoutMs} ms`);
    throw new ErroArquivo("REDE", "falha de rede ao consultar a fonte");
  } finally {
    clearTimeout(timer);
  }
}

async function consultar(cfg, eleicao, fetchImpl) {
  const consultadoEm = Date.now();
  const params = { base: cfg.base, ambiente: cfg.ambiente, ciclo: cfg.ciclo, eleicao, cargo: cfg.cargo };
  const resultados = await Promise.all(
    ABRANGENCIAS.map(async (uf) => {
      const chave = `${eleicao}:${uf}`;
      try {
        const json = await buscarJson(urlArquivo(params, uf), cfg.timeoutMs, fetchImpl);
        const dados = lerArquivo(json, { uf, eleicao });
        const anterior = ultimaValida.get(chave);
        // Resposta antiga de cache da fonte não sobrescreve uma leitura mais nova.
        if (anterior && !maisNovo(dados, anterior)) return [uf, { dados: anterior, erro: null }];
        ultimaValida.set(chave, dados);
        return [uf, { dados, erro: null }];
      } catch (err) {
        const erro = { codigo: err.codigo || "INTERNO", mensagem: err.message };
        const anterior = ultimaValida.get(chave);
        return [uf, anterior ? { dados: anterior, erro, desatualizado: true } : { dados: null, erro }];
      }
    }),
  );
  const escopos = Object.fromEntries(resultados);
  for (const item of Object.values(escopos)) {
    for (const c of item.dados?.candidatos || []) c.foto = urlFoto(params, c.sq);
  }
  const lidos = resultados.filter(([, r]) => r.dados && !r.erro).length;
  return {
    eleicao,
    fonte: {
      nome: "Tribunal Superior Eleitoral (TSE) — divulgação oficial de resultados",
      base: cfg.base,
      teste: cfg.teste,
      arquivoBrasil: urlArquivo(params, "br"),
    },
    consultadoEm,
    arquivosLidos: lidos,
    arquivosTotal: ABRANGENCIAS.length,
    escopos,
  };
}

// Devolve o instantâneo da eleição. Consultas concorrentes compartilham a mesma
// promessa (uma ida ao TSE por intervalo, não uma por visitante).
export async function obterResultados(eleicao, { cfg = lerConfig(), fetchImpl = fetch, agora = Date.now() } = {}) {
  const atual = memoria.get(eleicao);
  if (atual?.snapshot && agora - atual.em < cfg.ttlMs) return atual.snapshot;
  if (atual?.promessa) return atual.promessa;
  const promessa = consultar(cfg, eleicao, fetchImpl)
    .then((snapshot) => {
      memoria.set(eleicao, { em: Date.now(), snapshot, promessa: null });
      return snapshot;
    })
    .catch((err) => {
      memoria.delete(eleicao);
      throw err;
    });
  memoria.set(eleicao, { ...(atual || {}), promessa });
  return promessa;
}

// Resultado encerrado em todos os recortes lidos: pode ficar mais tempo em cache.
export function encerrado(snapshot) {
  const itens = Object.values(snapshot.escopos);
  return itens.length > 0 && itens.every((i) => i.dados?.status === "final" && !i.erro);
}
