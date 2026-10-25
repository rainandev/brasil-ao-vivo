// GET /api/resultados?turno=2  (turno=1 para o 1º turno)
// Rota intermediária: os visitantes leem daqui; só esta função consulta o TSE.
import { encerrado, lerConfig, obterResultados } from "../lib/fonte-tse.js";

export const config = { maxDuration: 15 };

function enviar(res, status, corpo, cacheControl) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(corpo));
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return enviar(res, 405, { erro: "método não permitido" }, "no-store");
  }
  const url = new URL(req.url, "http://localhost");
  const turno = url.searchParams.get("turno") || "2";
  const cfg = lerConfig();
  const eleicao = cfg.eleicoes[turno];
  if (!eleicao) return enviar(res, 400, { erro: "turno deve ser 1 ou 2" }, "public, s-maxage=3600");

  try {
    const snapshot = await obterResultados(eleicao, { cfg });
    const ttl = Math.round(cfg.ttlMs / 1000);
    // s-maxage vale para a CDN da Vercel (compartilhada entre visitantes); o navegador sempre revalida.
    const cache = encerrado(snapshot)
      ? "public, max-age=0, s-maxage=600, stale-while-revalidate=600"
      : snapshot.arquivosLidos === 0
        ? "public, max-age=0, s-maxage=10"
        : `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`;
    return enviar(res, 200, { turno: Number(turno), ...snapshot }, cache);
  } catch (err) {
    return enviar(res, 502, { erro: "falha ao consultar a fonte oficial", detalhe: String(err?.message || err) }, "public, max-age=0, s-maxage=5");
  }
}
