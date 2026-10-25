// Mapa 3D das UFs em Three.js: cada estado é a geometria real (mesmos caminhos do
// mapa 2D) extrudada. Renderiza sob demanda: o laço só roda enquanto há animação,
// e pausa fora da tela ou com a aba oculta.
import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";

const ALTURA = 16;
const ELEVA_HOVER = 7;
const ELEVA_SELEC = 22;
const INCLINACAO = THREE.MathUtils.degToRad(34);

export function webglDisponivel() {
  try {
    const c = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
}

export function criarMapa3D(container, geo, { aoSelecionar, aoPassar, reduzirMovimento = false }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = "mapa3d-canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.append(renderer.domElement);

  const rotulo = document.createElement("div");
  rotulo.className = "rotulo-3d";
  rotulo.hidden = true;
  container.append(rotulo);

  const cena = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 10, 6000);

  cena.add(new THREE.HemisphereLight(0xffffff, 0x0c0c0e, 1.05));
  const sol = new THREE.DirectionalLight(0xffffff, 1.6);
  sol.position.set(-300, -450, 900);
  cena.add(sol);
  const brasa = new THREE.PointLight(0xff1e2a, 0.9, 0, 0);
  brasa.position.set(420, 380, 160);
  cena.add(brasa);

  // Halo vermelho sob o mapa (textura gerada em canvas, sem arquivo extra).
  const halo = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(227,18,27,0.38)");
    grad.addColorStop(0.45, "rgba(227,18,27,0.10)");
    grad.addColorStop(1, "rgba(227,18,27,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1300, 1300), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    m.position.z = -30;
    return m;
  })();
  cena.add(halo);

  const mundo = new THREE.Group(); // recebe o leve giro de paralaxe
  cena.add(mundo);
  const mapa = new THREE.Group();
  mapa.scale.set(1, -1, 1); // SVG tem y para baixo
  mapa.position.set(-400, 400, 0);
  mundo.add(mapa);

  const loader = new SVGLoader();
  const estados = new Map();
  const corBase = new THREE.Color();
  for (const e of geo.estados) {
    const svg = loader.parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${e.d}"/></svg>`);
    const shapes = svg.paths.flatMap((p) => SVGLoader.createShapes(p));
    const geom = new THREE.ExtrudeGeometry(shapes, { depth: ALTURA, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 0.6, bevelSegments: 1, curveSegments: 2 });
    const topo = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.42, metalness: 0.18, emissive: 0x000000 });
    const lado = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.8, metalness: 0.1 });
    const malha = new THREE.Mesh(geom, [topo, lado]);
    const bordas = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 35), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
    malha.add(bordas);
    malha.userData.uf = e.uf;
    const pivo = new THREE.Group();
    pivo.add(malha);
    mapa.add(pivo);
    estados.set(e.uf, {
      e, pivo, malha, topo, lado,
      z: reduzirMovimento ? 0 : -420, zAlvo: 0,
      cor: new THREE.Color(0x141416), corAlvo: new THREE.Color(0x141416),
      brilho: 0, brilhoAlvo: 0, atraso: 0,
    });
  }

  // Onda de entrada a partir do centro do país.
  if (!reduzirMovimento) {
    for (const s of estados.values()) s.atraso = Math.hypot(s.e.cx - 470, s.e.cy - 430) / 420 * 0.9;
  }

  let selecionado = "br";
  let passando = null;
  let largura = 1;
  let altura = 1;
  let introT = reduzirMovimento ? 99 : 0;
  let visivel = true;
  let rodando = false;
  let ultimo = 0;
  const paralaxe = { x: 0, y: 0, ax: 0, ay: 0 };

  // Enquadramento: ajusta distância e alvo da câmera até a caixa do mapa ocupar ~90%
  // da área útil, em qualquer proporção de tela (celular em pé, deitado, desktop).
  const caixa = new THREE.Box3().setFromObject(mapa);
  const cantos = [];
  for (const x of [caixa.min.x, caixa.max.x]) for (const y of [caixa.min.y, caixa.max.y]) for (const z of [caixa.min.z, caixa.max.z]) cantos.push(new THREE.Vector3(x, y, z));
  const alvoCamera = new THREE.Vector3();
  function posicionarCamera(d) {
    camera.position.set(alvoCamera.x, alvoCamera.y - Math.sin(INCLINACAO) * d, Math.cos(INCLINACAO) * d);
    camera.lookAt(alvoCamera);
    camera.updateMatrixWorld();
  }
  function extensao() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const p = new THREE.Vector3();
    for (const c of cantos) {
      p.copy(c).project(camera);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { minX, maxX, minY, maxY };
  }
  function enquadrar() {
    const r = container.getBoundingClientRect();
    largura = Math.max(1, r.width);
    altura = Math.max(1, r.height);
    renderer.setSize(largura, altura, false);
    camera.aspect = largura / altura;
    camera.updateProjectionMatrix();
    alvoCamera.set(0, 0, 0);
    let d = 2000;
    for (let i = 0; i < 6; i++) {
      posicionarCamera(d);
      const ext = extensao();
      const escala = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY) / 2 / 0.99;
      d *= escala;
      posicionarCamera(d);
      const e2 = extensao();
      // Recentraliza verticalmente (a inclinação empurra o mapa para cima).
      alvoCamera.y += ((e2.maxY + e2.minY) / 2) * (caixa.max.y - caixa.min.y) * 0.5;
    }
    posicionarCamera(d);
    pedirQuadro();
  }

  const amortecer = (atual, alvo, dt, k) => atual + (alvo - atual) * (1 - Math.exp(-dt * k));
  // Saída com leve "quique": o estado sobe, passa um pouco e assenta.
  const voltar = (t) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; };
  const DURACAO_SUBIDA = 0.9;
  let inicioIntro = null;

  function quadro(agora) {
    // dt limitado a 0,25 s; a entrada usa o relógio real, então termina no tempo
    // certo mesmo em aparelhos lentos (poucos quadros por segundo).
    const dt = Math.min(0.25, (agora - (ultimo || agora)) / 1000);
    ultimo = agora;
    if (inicioIntro == null) inicioIntro = agora;
    introT = reduzirMovimento ? 99 : (agora - inicioIntro) / 1000;
    let ativo = false;

    for (const s of estados.values()) {
      const progresso = Math.min(1, Math.max(0, (introT - s.atraso) / DURACAO_SUBIDA));
      if (progresso < 1) {
        ativo = true;
        s.z = -420 * (1 - voltar(progresso));
      } else {
        s.z = reduzirMovimento ? s.zAlvo : amortecer(s.z, s.zAlvo, dt, 12);
      }
      const alvo = s.zAlvo;
      s.pivo.position.z = s.z;
      s.cor.lerp(s.corAlvo, reduzirMovimento ? 1 : 1 - Math.exp(-dt * 7));
      s.topo.color.copy(s.cor);
      s.lado.color.copy(corBase.copy(s.cor).multiplyScalar(0.42));
      s.brilho = amortecer(s.brilho, s.brilhoAlvo, dt, 5);
      s.topo.emissive.setRGB(0.55 * s.brilho, 0.04 * s.brilho, 0.05 * s.brilho);
      if (s.brilhoAlvo > 0 && s.brilho > s.brilhoAlvo - 0.02) s.brilhoAlvo = 0; // pulso de atualização
      if ((progresso >= 1 && Math.abs(s.z - alvo) > 0.05) || s.cor.getHex() !== s.corAlvo.getHex() || s.brilho > 0.01) ativo = true;
    }

    if (!reduzirMovimento) {
      paralaxe.ax = amortecer(paralaxe.ax, paralaxe.x, dt, 4);
      paralaxe.ay = amortecer(paralaxe.ay, paralaxe.y, dt, 4);
      mundo.rotation.y = paralaxe.ax * 0.07;
      mundo.rotation.x = -paralaxe.ay * 0.05;
      if (Math.abs(paralaxe.ax - paralaxe.x) > 0.001 || Math.abs(paralaxe.ay - paralaxe.y) > 0.001) ativo = true;
    }

    renderer.render(cena, camera);
    posicionarRotulo();
    rodando = ativo && visivel && !document.hidden;
    if (rodando) requestAnimationFrame(quadro);
    else ultimo = 0;
  }

  function pedirQuadro() {
    if (rodando || !visivel || document.hidden) return;
    rodando = true;
    requestAnimationFrame(quadro);
  }

  // ---- interação (pointer events cobrem mouse, toque e caneta) ----
  const raio = new THREE.Raycaster();
  const ponteiro = new THREE.Vector2();
  const malhas = [...estados.values()].map((s) => s.malha);

  function ufEm(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ponteiro.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raio.setFromCamera(ponteiro, camera);
    const hit = raio.intersectObjects(malhas, false)[0];
    return hit ? hit.object.userData.uf : null;
  }

  function aplicarElevacao() {
    for (const [uf, s] of estados) {
      s.zAlvo = uf === selecionado ? ELEVA_SELEC : uf === passando ? ELEVA_HOVER : 0;
    }
    pedirQuadro();
  }

  let inicio = null;
  const tela = renderer.domElement;
  tela.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "mouse") {
      const r = tela.getBoundingClientRect();
      paralaxe.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      paralaxe.y = ((ev.clientY - r.top) / r.height) * 2 - 1;
      const uf = ufEm(ev);
      if (uf !== passando) {
        passando = uf;
        tela.style.cursor = uf ? "pointer" : "default";
        aplicarElevacao();
      }
      aoPassar?.(uf, ev);
      pedirQuadro();
    }
  });
  tela.addEventListener("pointerleave", () => {
    passando = null;
    paralaxe.x = paralaxe.y = 0;
    aoPassar?.(null);
    aplicarElevacao();
  });
  tela.addEventListener("pointerdown", (ev) => { inicio = { x: ev.clientX, y: ev.clientY }; });
  tela.addEventListener("pointerup", (ev) => {
    if (!inicio || Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) > 10) return; // foi rolagem, não toque
    inicio = null;
    const uf = ufEm(ev);
    if (uf) aoSelecionar(uf === selecionado ? "br" : uf);
  });

  // ---- rótulo HTML sobre o estado selecionado ----
  const v = new THREE.Vector3();
  function projetar(uf) {
    const s = estados.get(uf);
    if (!s) return null;
    v.set(s.e.cx, s.e.cy, s.z + ALTURA + 2);
    mapa.localToWorld(v);
    v.project(camera);
    const r = tela.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height };
  }
  let textoRotulo = "";
  function posicionarRotulo() {
    if (selecionado === "br" || !textoRotulo) { rotulo.hidden = true; return; }
    const p = projetar(selecionado);
    if (!p) return;
    rotulo.hidden = false;
    rotulo.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, calc(-100% - 10px))`;
  }

  const ro = new ResizeObserver(enquadrar);
  ro.observe(container);
  const io = new IntersectionObserver(([en]) => { visivel = en.isIntersecting; if (visivel) pedirQuadro(); });
  io.observe(container);
  const aoMudarVisibilidade = () => { if (!document.hidden) pedirQuadro(); };
  document.addEventListener("visibilitychange", aoMudarVisibilidade);
  enquadrar();

  return {
    // cores: Map uf -> "#rrggbb"; pulsar: Set de UFs cujo dado mudou
    atualizar(cores, sel, rotuloSelecionado, pulsar = new Set()) {
      for (const [uf, s] of estados) {
        const hex = cores.get(uf) || "#141416";
        s.corAlvo.set(hex);
        if (sel !== "br" && uf !== sel) s.corAlvo.multiplyScalar(0.45); // foco no selecionado
        if (pulsar.has(uf) && !reduzirMovimento) s.brilhoAlvo = 1;
      }
      selecionado = sel;
      textoRotulo = rotuloSelecionado || "";
      rotulo.textContent = textoRotulo;
      aplicarElevacao();
    },
    projetar,
    // Diagnóstico (usado pelos testes): altura e nº de vértices de cada estado.
    inspecionar: () => [...estados].map(([uf, s]) => ({ uf, z: Math.round(s.z), vertices: s.malha.geometry.attributes.position.count })),
    destruir() {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", aoMudarVisibilidade);
      renderer.dispose();
      for (const s of estados.values()) { s.malha.geometry.dispose(); s.topo.dispose(); s.lado.dispose(); }
      container.replaceChildren();
    },
  };
}
