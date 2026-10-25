// Servidor local que imita a Vercel: arquivos de public/ + função /api/resultados.
// Uso: npm run dev  (porta 3000, ou PORT=...)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { responderResultados } from "../lib/fonte-tse.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp",
};

// fetchImpl só é trocado pelos testes automatizados; npm run dev usa o TSE real.
export function criarServidor({ fetchImpl = fetch } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/resultados") return responderResultados(req, res, { fetchImpl });
    let caminho = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (caminho.endsWith("/")) caminho += "index.html";
    try {
      const corpo = await readFile(join(PUBLIC, caminho));
      res.writeHead(200, { "Content-Type": TIPOS[extname(caminho)] || "application/octet-stream" });
      res.end(corpo);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("não encontrado");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const porta = Number(process.env.PORT || 3000);
  criarServidor().listen(porta, () => console.log(`BRASIL // AO VIVO em http://localhost:${porta}`));
}
