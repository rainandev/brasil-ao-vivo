// DADOS ARTIFICIAIS PARA TESTES AUTOMATIZADOS.
// Candidatos e números fictícios ("CANDIDATA TESTE ALFA" etc.), com o mesmo
// formato do arquivo -u.json do TSE. Nunca são importados por public/ nem por api/.
import { UFS } from "../../public/js/core.js";

export const CAND_TESTE = [
  { n: "91", nm: "CANDIDATA TESTE ALFA", sg: "PTA", sqcand: "900000000001" },
  { n: "92", nm: "CANDIDATO TESTE BETA", sg: "PTB", sqcand: "900000000002" },
];

const pct = (parte, total) => (total ? ((parte / total) * 100).toFixed(2).replace(".", ",") : "0,00");

// votos: [vapAlfa, vapBeta]
export function arquivoTeste({ uf = "br", ele = "6258", st = 0, ts = 1000, votos = [0, 0], vb = 0, tvn = 0, a = 0,
  dg = "25/10/2026", hg = "17:00:00", and = "p", cand = CAND_TESTE } = {}) {
  const vv = votos.reduce((s, v) => s + v, 0);
  const comparecimento = vv + vb + tvn;
  return {
    ele: Number(ele), t: "2", cdabr: uf.toUpperCase(), dg, hg, and,
    s: { ts: String(ts), st: String(st), pst: pct(st, ts) },
    e: { a: String(a), pa: pct(a, comparecimento + a) },
    v: { vv: String(vv), vb: String(vb), pvb: pct(vb, comparecimento), tvn: String(tvn), ptvn: pct(tvn, comparecimento) },
    carg: [{ cd: "1", agr: [{ par: cand.map((c, i) => ({ sg: c.sg, cand: [{
      n: c.n, sqcand: c.sqcand, nm: c.nm, nmu: c.nm, vap: String(votos[i] ?? 0), pvap: pct(votos[i] ?? 0, vv), st: "",
    }] })) }] }],
  };
}

// Cenário completo (Brasil + UFs) em que ALFA lidera em metade das UFs.
export function cenario({ ele = "6258", st = 500, hg = "18:00:00", and = "p", deslocamento = 0 } = {}) {
  const arquivos = {};
  let somaA = 0, somaB = 0;
  UFS.forEach((uf, i) => {
    const a = 10000 + i * 1000 + deslocamento;
    const b = 10000 + (UFS.length - i) * 1000;
    somaA += a; somaB += b;
    arquivos[uf] = arquivoTeste({ uf, ele, st, votos: [a, b], vb: 100, tvn: 200, a: 300, hg, and });
  });
  arquivos.br = arquivoTeste({ uf: "br", ele, st: st * 27, ts: 27000, votos: [somaA, somaB], vb: 2700, tvn: 5400, a: 8100, hg, and });
  return arquivos;
}
