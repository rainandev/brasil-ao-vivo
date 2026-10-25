// fetch falso para os testes: responde às URLs oficiais do TSE com dados definidos
// pelo próprio teste. Só existe em tests/; o site publicado usa sempre o fetch real.
export function criarFetchFalso() {
  let responder = () => ({ status: 404 });
  const pedidos = [];
  async function fetchFalso(url, opts = {}) {
    pedidos.push(String(url));
    const m = /\/oficial\/ele2026\/(\d+)\/dados\/([a-z]{2})\/\2-c0001-e0*(\d+)-u\.json$/.exec(String(url));
    if (!m) return new Response("", { status: 404 });
    const r = (await responder(m[2], m[1])) || { status: 404 };
    if (r.atraso) {
      await new Promise((ok, falha) => {
        const t = setTimeout(ok, r.atraso);
        opts.signal?.addEventListener("abort", () => { clearTimeout(t); falha(Object.assign(new Error("abortado"), { name: "AbortError" })); });
      });
    }
    if (r.rede) throw new TypeError("fetch failed");
    return new Response(r.bruto ?? (r.corpo ? JSON.stringify(r.corpo) : ""), { status: r.status || 200, headers: { "content-type": "application/json" } });
  }
  return {
    fetch: fetchFalso,
    pedidos,
    definir(fn) { responder = fn; },
    usarArquivos(arquivos) { responder = (uf) => (arquivos[uf] ? { corpo: arquivos[uf] } : { status: 404 }); },
  };
}
