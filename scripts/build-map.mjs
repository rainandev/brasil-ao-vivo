// Gera public/data/brasil-uf.json (caminhos SVG já projetados) a partir do GeoJSON
// das 27 UFs em data-src/brazil-states.geojson.
// Fonte da geometria: codeforgermany/click_that_hood (brazil-states.geojson), malha IBGE.
// Uso: npm run build:map
import { readFileSync, writeFileSync } from "node:fs";
import { geoMercator, geoPath } from "d3-geo";
import { topology } from "topojson-server";
import { presimplify, simplify, quantile } from "topojson-simplify";
import { feature } from "topojson-client";

const WIDTH = 800;
const HEIGHT = 800;

const REGIOES = {
  norte: ["AC", "AP", "AM", "PA", "RO", "RR", "TO"],
  nordeste: ["AL", "BA", "CE", "MA", "PB", "PE", "PI", "RN", "SE"],
  "centro-oeste": ["DF", "GO", "MS", "MT"],
  sudeste: ["ES", "MG", "RJ", "SP"],
  sul: ["PR", "RS", "SC"],
};
const regiaoDe = (uf) => Object.keys(REGIOES).find((r) => REGIOES[r].includes(uf));

const src = JSON.parse(readFileSync(new URL("../data-src/brazil-states.geojson", import.meta.url)));
if (src.features.length !== 27) throw new Error(`esperava 27 UFs, veio ${src.features.length}`);

// Simplificação topológica: mantém fronteiras compartilhadas sem buracos entre estados.
let topo = topology({ ufs: src }, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.06));
const simplified = feature(topo, topo.objects.ufs);

const projection = geoMercator().fitExtent([[10, 10], [WIDTH - 10, HEIGHT - 10]], simplified);
const path = geoPath(projection).digits(1);

const estados = simplified.features
  .map((f) => {
    const uf = f.properties.sigla.toUpperCase();
    const [cx, cy] = path.centroid(f);
    return {
      uf: uf.toLowerCase(),
      nome: f.properties.name,
      regiao: regiaoDe(uf),
      cx: Math.round(cx * 10) / 10,
      cy: Math.round(cy * 10) / 10,
      d: path(f),
    };
  })
  .sort((a, b) => a.uf.localeCompare(b.uf));

const out = {
  fonte: "Malha das UFs (IBGE) via codeforgermany/click_that_hood, projeção Mercator, simplificada",
  viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
  estados,
};
const target = new URL("../public/data/brasil-uf.json", import.meta.url);
writeFileSync(target, JSON.stringify(out));
console.log(`ok: ${estados.length} UFs, ${(JSON.stringify(out).length / 1024).toFixed(1)} KB`);
