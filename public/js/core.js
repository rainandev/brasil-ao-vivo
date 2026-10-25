// Núcleo isomórfico (navegador + função da Vercel): lê e valida os arquivos
// de resultado unificado do TSE (sufixo -u.json, especificação EA20).
// Não calcula percentuais exibidos: usa os campos oficiais (pvap, s.pst, v.pvb...).
// Contas próprias servem só para conferir a consistência do arquivo.

export const UFS = [
  "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa",
  "pb", "pe", "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to",
];

// Abrangências lidas a cada ciclo: Brasil, 27 UFs e Exterior.
export const ABRANGENCIAS = ["br", ...UFS, "zz"];

export const NOMES = {
  br: "Brasil", zz: "Exterior",
  ac: "Acre", al: "Alagoas", am: "Amazonas", ap: "Amapá", ba: "Bahia", ce: "Ceará",
  df: "Distrito Federal", es: "Espírito Santo", go: "Goiás", ma: "Maranhão",
  mg: "Minas Gerais", ms: "Mato Grosso do Sul", mt: "Mato Grosso", pa: "Pará",
  pb: "Paraíba", pe: "Pernambuco", pi: "Piauí", pr: "Paraná", rj: "Rio de Janeiro",
  rn: "Rio Grande do Norte", ro: "Rondônia", rr: "Roraima", rs: "Rio Grande do Sul",
  sc: "Santa Catarina", se: "Sergipe", sp: "São Paulo", to: "Tocantins",
};

export const FONTE_OFICIAL = "https://resultados.tse.jus.br";

// URL do arquivo -u.json: <base>/<ambiente>/<ciclo>/<eleicao>/dados/<uf>/<uf>-c<cargo 4d>-e<eleicao 6d>-u.json
export function urlArquivo({ base, ambiente, ciclo, eleicao, cargo = 1 }, uf) {
  const abr = String(uf).toLowerCase();
  const c = String(cargo).padStart(4, "0");
  const e = String(eleicao).padStart(6, "0");
  return `${base}/${ambiente}/${ciclo}/${eleicao}/dados/${abr}/${abr}-c${c}-e${e}-u.json`;
}

export function urlFoto({ base, ambiente, ciclo, eleicao }, sq) {
  if (!/^\d+$/.test(String(sq || ""))) return null;
  return `${base}/${ambiente}/${ciclo}/${eleicao}/fotos/br/${sq}.jpeg`;
}

// Inteiro oficial: só aceita dígitos. "1.234" ou "12,5" não são contagens válidas.
export function inteiro(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  const t = String(v).trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

// Percentual oficial em texto ("47,03") -> número (47.03). Mantém o texto original para exibir.
export function percentual(v) {
  if (v == null || v === "") return null;
  const t = String(v).trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

// dg "dd/mm/aaaa" + hg "hh:mm:ss", horário de Brasília (UTC-3, sem horário de verão desde 2019).
export function instanteTse(dg, hg) {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dg || "").trim());
  const h = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(hg || "").trim());
  if (!d || !h) return null;
  const ms = Date.UTC(+d[3], +d[2] - 1, +d[1], +h[1] + 3, +h[2], +h[3]);
  return Number.isFinite(ms) ? ms : null;
}

export class ErroArquivo extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

// Converte o JSON bruto do TSE num recorte normalizado. Lança ErroArquivo se a
// estrutura não for a esperada (o chamador mantém a última leitura válida).
export function lerArquivo(json, { uf, eleicao } = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ErroArquivo("ESTRUTURA", "arquivo vazio ou não é um objeto JSON");
  }
  const abr = String(json.cdabr ?? "").toLowerCase();
  if (uf && abr && abr !== String(uf).toLowerCase()) {
    throw new ErroArquivo("ABRANGENCIA", `arquivo de ${abr}, esperado ${uf}`);
  }
  if (eleicao && json.ele != null && Number(json.ele) !== Number(eleicao)) {
    throw new ErroArquivo("ELEICAO", `arquivo da eleição ${json.ele}, esperada ${eleicao}`);
  }
  if (!json.s || typeof json.s !== "object") throw new ErroArquivo("ESTRUTURA", "sem bloco de seções (s)");
  if (!Array.isArray(json.carg) || !json.carg.length) throw new ErroArquivo("ESTRUTURA", "sem bloco de cargo (carg)");

  const totalizadas = inteiro(json.s.st);
  const totalSecoes = inteiro(json.s.ts);
  if (totalizadas == null || totalSecoes == null || totalSecoes === 0 || totalizadas > totalSecoes) {
    throw new ErroArquivo("SECOES", "contagem de seções ausente ou incoerente");
  }

  const cargo = json.carg.find((c) => Number(c.cd) === 1) || json.carg[0];
  const candidatos = [];
  for (const agr of cargo.agr || []) {
    for (const par of agr.par || []) {
      for (const cand of par.cand || []) {
        const votos = inteiro(cand.vap);
        if (votos == null) throw new ErroArquivo("VOTOS", `votos inválidos para o candidato ${cand.n}`);
        candidatos.push({
          numero: String(cand.n ?? ""),
          sq: String(cand.sqcand ?? ""),
          nome: String(cand.nmu || cand.nm || "").trim(),
          partido: String(par.sg ?? "").trim(),
          votos,
          pct: cand.pvap == null ? null : String(cand.pvap),
          pctNum: percentual(cand.pvap),
          situacao: String(cand.st ?? "").trim(),
        });
      }
    }
  }
  if (!candidatos.length) throw new ErroArquivo("ESTRUTURA", "nenhum candidato no arquivo");
  if (candidatos.some((c) => !c.nome)) throw new ErroArquivo("ESTRUTURA", "candidato sem nome");

  const v = json.v || {};
  const e = json.e || {};
  const validos = inteiro(v.vv);
  const andamento = String(json.and ?? "").trim().toLowerCase();
  const dataRef = instanteTse(json.dg, json.hg);
  const iniciada = totalizadas > 0;

  candidatos.sort((a, b) => b.votos - a.votos || Number(a.numero) - Number(b.numero));

  const avisos = [];
  if (iniciada) {
    const soma = candidatos.reduce((s, c) => s + c.votos, 0);
    if (validos == null) avisos.push("arquivo sem total de votos válidos");
    else if (soma !== validos) avisos.push(`soma dos votos (${soma}) difere dos válidos (${validos})`);
    if (validos) {
      for (const c of candidatos) {
        if (c.pctNum == null) { avisos.push(`percentual ausente para ${c.nome}`); continue; }
        const conferido = (c.votos / validos) * 100;
        if (Math.abs(conferido - c.pctNum) > 0.02) avisos.push(`percentual de ${c.nome} não confere com votos/válidos`);
      }
    }
  }

  return {
    uf: abr || String(uf || "").toLowerCase(),
    eleicao: String(json.ele ?? eleicao ?? ""),
    turno: String(json.t ?? ""),
    dg: String(json.dg ?? ""),
    hg: String(json.hg ?? ""),
    dataRef,
    andamento,
    status: !iniciada ? "aguardando" : andamento === "f" ? "final" : "parcial",
    secoes: { totalizadas, total: totalSecoes, pct: json.s.pst == null ? null : String(json.s.pst), pctNum: percentual(json.s.pst) },
    votos: {
      validos,
      brancos: inteiro(v.vb), pctBrancos: v.pvb == null ? null : String(v.pvb),
      nulos: inteiro(v.tvn), pctNulos: v.ptvn == null ? null : String(v.ptvn),
      abstencao: inteiro(e.a), pctAbstencao: e.pa == null ? null : String(e.pa),
    },
    candidatos,
    avisos,
  };
}

// Uma leitura é mais nova que outra se o horário do TSE avançou ou, no mesmo
// horário, se mais seções foram totalizadas. Evita voltar a números antigos.
export function maisNovo(a, b) {
  if (!b) return true;
  if (!a) return false;
  const ta = a.dataRef ?? -Infinity;
  const tb = b.dataRef ?? -Infinity;
  if (ta !== tb) return ta > tb;
  return a.secoes.totalizadas >= b.secoes.totalizadas;
}

// Junta um novo instantâneo ao anterior, recorte a recorte, sem retroceder.
export function mesclar(anterior, novo) {
  if (!anterior || anterior.eleicao !== novo.eleicao) return novo;
  const escopos = { ...anterior.escopos };
  for (const [uf, item] of Object.entries(novo.escopos)) {
    const antigo = anterior.escopos[uf];
    if (item.dados && (!antigo?.dados || maisNovo(item.dados, antigo.dados))) escopos[uf] = item;
    else if (!item.dados && antigo?.dados) escopos[uf] = { ...antigo, erro: item.erro, desatualizado: true };
    else if (!antigo) escopos[uf] = item;
  }
  return { ...novo, escopos };
}

// Escolhe os dois candidatos de referência para a cor do mapa: os dois mais
// votados no Brasil. Ordem fixa pelo número de urna para a cor não trocar.
export function candidatosReferencia(br) {
  if (!br || !br.candidatos?.length) return [];
  return br.candidatos.slice(0, 2).map((c) => c.numero).sort((a, b) => Number(a) - Number(b));
}

// Classe de cor de um estado: quem lidera e por quanto (pontos percentuais oficiais).
export function corEstado(dados, referencia) {
  if (!dados || dados.status === "aguardando") return { classe: "sem-dados", lider: null, margem: null };
  const [p, s] = dados.candidatos;
  if (!p || p.pctNum == null) return { classe: "sem-dados", lider: null, margem: null };
  const margem = s?.pctNum != null ? p.pctNum - s.pctNum : p.pctNum;
  const slot = referencia.indexOf(p.numero);
  const nome = slot === 0 ? "a" : slot === 1 ? "b" : "outro";
  if (margem < 1) return { classe: "empate", lider: p, margem };
  const faixa = margem < 10 ? 1 : margem < 20 ? 2 : 3;
  return { classe: `${nome}-${faixa}`, lider: p, margem };
}

const fmtInt = new Intl.NumberFormat("pt-BR");
export function formatarVotos(n) {
  return n == null ? "—" : fmtInt.format(n);
}
export function formatarPct(texto) {
  if (texto == null || texto === "") return "—";
  return `${String(texto).replace(".", ",")}%`;
}
