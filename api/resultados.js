// GET /api/resultados?turno=2  (turno=1 para o 1º turno)
// Rota intermediária: os visitantes leem daqui; só esta função consulta o TSE.
import { responderResultados } from "../lib/fonte-tse.js";

export const config = { maxDuration: 15 };

export default function handler(req, res) {
  return responderResultados(req, res);
}
