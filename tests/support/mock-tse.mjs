// Servidor HTTP local que imita o caminho de arquivos do TSE para os testes.
import { createServer } from "node:http";

export function iniciarMockTse() {
  let responder = () => ({ status: 404 });
  const pedidos = [];
  const server = createServer((req, res) => {
    const m = /^\/oficial\/ele2026\/(\d+)\/dados\/([a-z]{2})\/\2-c0001-e0*(\d+)-u\.json$/.exec(req.url);
    pedidos.push(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const r = responder(m[2], m[1]) || { status: 404 };
    if (r.atraso) return setTimeout(() => enviar(res, r), r.atraso);
    enviar(res, r);
  });
  function enviar(res, r) {
    res.writeHead(r.status || 200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(r.bruto ?? (r.corpo ? JSON.stringify(r.corpo) : ""));
  }
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    pedidos,
    definir(fn) { responder = fn; },
    usarArquivos(arquivos) { responder = (uf) => (arquivos[uf] ? { corpo: arquivos[uf] } : { status: 404 }); },
    fechar: () => new Promise((f) => server.close(f)),
  })));
}
