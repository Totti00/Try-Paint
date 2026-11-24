// mode3d.js — video 3D: model.glb + parts.json + AnimationPlan -> scena animata deterministica.
// Stile del video originale: fondale chiaro, contorni sottili, ombre morbide, arancio sulle parti che
// si muovono, stacchi con dissolvenza (niente panoramiche veloci), didascalia sempre presente.

import * as THREE from 'three';
import { makeRenderer, setupStudio, loadPartsModel, analyzePart, styleParts, Rig, poseOrbit } from './scene3d.js';
import { Choreography, planCamera, TIMING, boxCorners } from './plan3d.js';
import { compileTrack, evalChannel, windowFade, clamp01, EASE } from './anim.js';
import { Brand, Caption, EndCard, el, vis } from './ui.js';
import { esc, qtyLabel } from './text.js';

const DEG = Math.PI / 180;

export async function createEngine({ cfg, theme, stage, W, H }) {
  const plan = cfg.plan, manual = cfg.manual;
  if (!plan) throw new Error('Piano dell’animazione mancante');
  if (!cfg.glbUrl) throw new Error('Modello 3D mancante');

  // ----------------------------------------------------------------- modello
  const model = await loadPartsModel(cfg.glbUrl, cfg.parts);
  for (const p of model.parts) p.info = analyzePart(p);
  const size = model.box.getSize(new THREE.Vector3());
  const D = size.length() || 1;
  const roles = new Map();
  for (const r of plan.parts || []) if (model.byKey.has(r.key)) roles.set(r.key, r.role);
  for (const p of model.parts) {
    if (roles.has(p.key)) continue;
    const small = Math.max(p.size.x, p.size.y, p.size.z) < 0.08 * D;
    roles.set(p.key, small && (p.info.shape === 'rod' || p.info.shape === 'disc') ? 'hardware' : 'component');
  }
  styleParts(model.parts, { roles, theme, ink: theme.ink });

  const canvas = document.getElementById('gl');
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const renderer = makeRenderer(canvas, W, H);
  const scene = new THREE.Scene();
  setupStudio(renderer, scene, { radius: D * 0.75, mapSize: W >= 1600 ? 2048 : 1536 });
  const rig = new Rig(scene, model, { theme, ink: theme.ink });
  for (const p of model.parts) p.localBox = p.box.clone().translate(p.base.clone().negate());
  const I4 = new THREE.Matrix4();
  rig.setFrame(I4);
  scene.updateMatrixWorld(true);

  // ----------------------------------------------------------------- raggi (visibilita')
  const raycaster = new THREE.Raycaster();
  const heavy = model.parts.reduce((n, p) => n + p.triangles, 0) > 250000;
  const owner = new Map();
  for (const p of model.parts) for (const m of p.meshes) owner.set(m, p.key);
  const allMeshes = model.parts.flatMap((p) => p.meshes.filter((m) => !m.userData.basic));
  const raycastFinal = (origin, dir, maxDist, exclude = []) => {
    raycaster.set(origin, dir.clone().normalize());
    raycaster.near = 0; raycaster.far = maxDist;
    const list = allMeshes.filter((m) => !exclude.includes(owner.get(m)));
    const h = raycaster.intersectObjects(list, false)[0];
    return h ? { key: owner.get(h.object), distance: h.distance } : null;
  };

  const ch = new Choreography({ plan, manual, model, roles, raycastFinal }).build();

  // ----------------------------------------------------------------- posa della scena
  const M4 = new THREE.Matrix4(), ONE = new THREE.Vector3(1, 1, 1);
  const states = new Map();
  function poseAt(t) {
    const F = ch.frameAt(t);
    M4.compose(F.t, F.q, ONE);
    rig.setFrame(M4);
    for (const p of model.parts) {
      const st = ch.partState(p.key, t);
      states.set(p.key, st);
      rig.setPart(p, st);
    }
    scene.updateMatrixWorld(true);
    return F;
  }
  const camTmp = new THREE.PerspectiveCamera(30, W / H, 1, 1e7);
  const cameraPosition = (f) => {
    const A = f.az * DEG, E = f.el * DEG;
    const tg = f.target.isVector3 ? f.target : new THREE.Vector3(...f.target);
    return new THREE.Vector3(tg.x + f.dist * Math.cos(E) * Math.sin(A), tg.y + f.dist * Math.sin(E), tg.z + f.dist * Math.cos(E) * Math.cos(A));
  };
  const boxesAt = (t, only = null, exclude = null) => {
    poseAt(t);
    const out = [];
    for (const p of model.parts) {
      if (only && !only.includes(p.key)) continue;
      if (exclude && exclude.includes(p.key)) continue;
      const st = states.get(p.key);
      if (st.o < 0.5) continue;
      if (!only && ch.entering(p.key, t)) continue;
      out.push(p.localBox.clone().applyMatrix4(p.node.matrixWorld));
    }
    return out;
  };
  const worldPointsOf = (keys, t) => {
    poseAt(t);
    const pts = [];
    for (const k of keys) {
      const p = model.byKey.get(k);
      if (!p) continue;
      const c = p.localBox.getCenter(new THREE.Vector3()), s = p.localBox.getSize(new THREE.Vector3());
      const loc = [c.clone(), (p.info && p.info.centroid) ? p.info.centroid.clone() : c.clone()];
      for (const [i, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
        const v = c.clone(); v.setComponent(i, v.getComponent(i) + sgn * 0.3 * s.getComponent(i)); loc.push(v);
      }
      for (const v of heavy ? loc.slice(0, 4) : loc) pts.push({ key: k, v: v.applyMatrix4(p.node.matrixWorld) });
    }
    return pts;
  };
  const visibility = (f, pts, focusKeys, t) => {
    poseAt(t);
    const cam = cameraPosition(f);
    const list = allMeshes.filter((m) => (states.get(owner.get(m))?.o ?? 1) > 0.5);
    let ok = 0;
    const dir = new THREE.Vector3();
    for (const { v } of pts) {
      dir.subVectors(v, cam);
      const dist = dir.length();
      raycaster.set(cam, dir.normalize());
      raycaster.near = 0; raycaster.far = dist + 0.01 * D;
      const h = raycaster.intersectObjects(list, false)[0];
      if (!h || focusKeys.includes(owner.get(h.object)) || h.distance > dist - 0.004 * D) ok++;
    }
    return pts.length ? ok / pts.length : 0;
  };
  const localToWorldDir = (dir, t) => dir.clone().applyQuaternion(ch.frameAt(t).q);
  const hasHwCard = (manual.hardware || []).length > 0;
  const { shots } = planCamera(ch, { W, H, poseAt, boxesAt, worldPointsOf, visibility, cameraPosition, localToWorldDir, hasHwCard, heavy });
  for (const sh of shots) sh.track = compileTrack(sh.keys.map(({ dist, ...k }) => ({ ...k, ld: Math.log(dist) })));
  const shotIndexAt = (t) => { let i = 0; while (i + 1 < shots.length && shots[i + 1].t0 <= t) i++; return i; };

  // ----------------------------------------------------------------- camera e dissolvenze
  const camera = new THREE.PerspectiveCamera(30, W / H, 1, 1e7);
  const camPrev = new THREE.PerspectiveCamera(30, W / H, 1, 1e7);
  const ghost = document.getElementById('ghost');
  ghost.width = W; ghost.height = H;
  ghost.style.width = W + 'px'; ghost.style.height = H + 'px';
  const gctx = ghost.getContext('2d');
  const dimEl = document.getElementById('dim');
  const nearK = (dist) => clamp01((1.1 * D - dist) / (0.6 * D));
  function poseCamera(cam, shot, t) {
    const c = shot.track;
    const target = evalChannel(c.target, t, [0, 0, 0]);
    const dist = Math.exp(evalChannel(c.ld, t, Math.log(D * 2)));
    poseOrbit(cam, W, H, { target, dist, az: evalChannel(c.az, t, 35), el: evalChannel(c.el, t, 24), fov: evalChannel(c.fov, t, 30), sx: evalChannel(c.sx, t, 0), sy: evalChannel(c.sy, t, 0.08) });
    return dist;
  }

  // ----------------------------------------------------------------- aloni sulla minuteria
  const ring = document.createElement('canvas');
  ring.width = ring.height = 128;
  { const g = ring.getContext('2d'); g.strokeStyle = '#fff'; g.lineWidth = 10; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke(); }
  const ringTex = new THREE.CanvasTexture(ring);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  const halos = [];
  for (const k of ch.halo) {
    const mat = new THREE.SpriteMaterial({ map: ringTex, color: new THREE.Color(theme.accent), transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = 10; sp.visible = false;
    scene.add(sp);
    halos.push({ key: k, sp, mat, p: model.byKey.get(k) });
  }
  const tmpV = new THREE.Vector3();
  function updateHalos(cam) {
    const tanF = Math.tan(cam.fov * DEG / 2);
    for (const hl of halos) {
      const st = states.get(hl.key);
      const a = st ? st.h * st.o : 0;
      if (a < 0.02) { hl.sp.visible = false; continue; }
      const c = hl.p.info && hl.p.info.centroid ? hl.p.info.centroid : new THREE.Vector3();
      hl.sp.position.copy(c).applyMatrix4(hl.p.node.matrixWorld);
      const d = tmpV.copy(hl.sp.position).sub(cam.position).length();
      const worldPerPx = 2 * d * tanF / 1080;
      const px = Math.max(hl.p.size.x, hl.p.size.y, hl.p.size.z) / worldPerPx;
      const small = clamp01((26 - px) / 14);
      hl.sp.visible = small * a > 0.02;
      hl.mat.opacity = 0.95 * a * small;
      const k = (70 + 40 * (1 - a)) * worldPerPx;
      hl.sp.scale.set(k, k, 1);
    }
  }

  // ----------------------------------------------------------------- grafica 2D
  const brand = new Brand(stage, manual.short_name || plan.title || '', manual.document_title || 'Istruzioni di montaggio');
  const intro = el('div', null, `<div class="kicker">${esc(manual.document_title || 'Istruzioni di montaggio')}</div><h1>${esc(plan.title || manual.short_name || '')}</h1><div class="rule"></div>${plan.subtitle ? `<div class="sub">${esc(plan.subtitle)}</div>` : ''}`);
  intro.id = 'intro';
  stage.appendChild(intro);
  { const h1 = intro.querySelector('h1'); const { fitText } = await import('./text.js'); fitText(h1, { maxW: 1500, min: 60 }); }

  // etichette dei componenti (una per sigla)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'leaders';
  svg.setAttribute('viewBox', '0 0 1920 1080');
  stage.appendChild(svg);
  const roleRef = new Map((plan.parts || []).map((r) => [r.key, r.ref]));
  const compByCode = new Map((manual.components || []).map((c) => [c.code, c]));
  const cw = ch.componentsWindow;
  const byRef = new Map();
  for (const k of cw.comps) {
    const ref = roleRef.get(k);
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(model.byKey.get(k));
  }
  const labels = [...byRef.entries()].slice(0, 8).map(([ref, ps], i) => {
    const anchor = ps.slice().sort((a, b) => b.size.length() - a.size.length())[0];
    const comp = compByCode.get(ref);
    const qty = comp && comp.qty ? comp.qty : ps.length;
    const e = el('div', 'label', `<span class="code">${esc(ref)}</span>${comp ? `<span class="name">${esc(shortName(comp.name))}</span>` : ''}<span class="qty">${esc(qtyLabel(qty))}</span>`);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('stroke', theme.ink); line.setAttribute('stroke-width', '2.5');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '8'); dot.setAttribute('fill', theme.accent); dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '3');
    svg.append(line, dot);
    stage.appendChild(e);
    vis(e, 0);
    return { e, line, dot, part: anchor, t0: cw.t0 + 2.5 + i * 0.22, t1: cw.t1 - 0.8, dx: 0, dy: 0 };
  });

  // riquadro della ferramenta
  let hw = null;
  if (hasHwCard) {
    const rows = manual.hardware.slice(0, 4);
    const imgOf = (id) => (id && cfg.images && cfg.images[id] ? cfg.images[id].url : null);
    hw = el('div', null, `<h3>Ferramenta in dotazione</h3>` + rows.map((r) => {
      const u = imgOf(r.image_id);
      return `<div class="row"><div class="ph${u ? '' : ' none'}">${u ? `<img src="${esc(u)}" alt="">` : ''}</div><div class="nm">${esc(r.name)}${r.spec ? `<small>${esc(r.spec)}</small>` : ''}</div><div class="q">${esc(qtyLabel(r.qty))}</div></div>`;
    }).join('') + (manual.hardware.length > 4 ? `<div class="more">e altri ${manual.hardware.length - 4} articoli</div>` : ''));
    hw.id = 'hw';
    stage.appendChild(hw);
    vis(hw, 0);
  }

  // etichette di quantita' (×N) durante le avvitature
  const tags = ch.tags.map((tg) => { const e = el('div', 'tag3d', esc(tg.text)); stage.appendChild(e); vis(e, 0); return { ...tg, e }; });

  const caption = new Caption(stage, { total: ch.numberedCount });
  const end = new EndCard(stage, {
    logoUrl: manual.brand_logo_image_id && cfg.images && cfg.images[manual.brand_logo_image_id] ? cfg.images[manual.brand_logo_image_id].url : null,
    name: manual.short_name || plan.title, docTitle: manual.document_title || 'Istruzioni di montaggio',
  });
  await Promise.all([...stage.querySelectorAll('img')].map((img) => (img.complete ? img.decode() : new Promise((r) => { img.onload = r; img.onerror = r; })).catch(() => {})));
  await end.prepare();

  const capItems = ch.captions.map((c, i) => ({ ...c, id: 'c' + i, item: { id: 'c' + i, kind: c.kind, n: c.n, title: c.title, body: c.body } }));
  const stepCaps = capItems.filter((c) => c.kind === 'step');
  for (const c of capItems) caption.setItem(c.item);

  // posizione delle etichette: calcolata una volta a meta' dell'esploso (offset fissi)
  const project = (cam, v) => { const p = v.clone().project(cam); return { x: (p.x + 1) * 960, y: (1 - p.y) * 540, behind: p.z > 1 }; };
  if (labels.length) {
    const tm = cw.t0 + 3.6;
    poseAt(tm);
    const sh = shots[shotIndexAt(tm)];
    poseCamera(camera, sh, tm);
    const pts = labels.map((L) => project(camera, L.part.localBox.getCenter(new THREE.Vector3()).applyMatrix4(L.part.node.matrixWorld)));
    const cx = pts.reduce((n, p) => n + p.x, 0) / pts.length, cy = pts.reduce((n, p) => n + p.y, 0) / pts.length;
    const maxX = hw ? 1180 : 1820;
    labels.forEach((L, i) => {
      const p = pts[i];
      let dx = p.x - cx, dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      dx = dx / len * 120; dy = dy / len * 80;
      if (Math.abs(dx) < 50) dx = (i % 2 ? -1 : 1) * 90;
      L.side = dx >= 0 ? 1 : -1;
      L.dx = dx; L.dy = dy;
      L.ax = p.x; L.ay = p.y;
    });
    // separazione verticale delle etichette dello stesso lato
    for (const side of [-1, 1]) {
      const g = labels.filter((L) => L.side === side).sort((a, b) => (a.ay + a.dy) - (b.ay + b.dy));
      for (let i = 1; i < g.length; i++) {
        const prevY = g[i - 1].ay + g[i - 1].dy, y = g[i].ay + g[i].dy;
        if (y - prevY < 78) g[i].dy += 78 - (y - prevY);
      }
    }
    for (const L of labels) {
      const w = L.e.offsetWidth, h = L.e.offsetHeight;
      const x = L.ax + L.dx, y = L.ay + L.dy;
      const left = L.side > 0 ? x : x - w;
      if (left + w > maxX) L.dx -= left + w - maxX;
      if (left < 60) L.dx += 60 - left;
      if (y - h / 2 < 130) L.dy += 130 - (y - h / 2);
      if (y + h / 2 > 800) L.dy -= y + h / 2 - 800;
    }
  }

  // ----------------------------------------------------------------- disegno
  const capFrom = capItems.length ? capItems[0].t0 : ch.componentsWindow.t0;
  const capTo = ch.endcard.t0 + 0.2;

  function overlay(t, cam, dist) {
    // titolo
    const ai = windowFade(t, 0.15, TIMING.intro - 0.2, 0.7, 0.6);
    vis(intro, ai);
    intro.style.transform = `translateY(${((1 - EASE.out(clamp01((t - 0.15) / 0.9))) * 30).toFixed(1)}px)`;
    const near = nearK(dist);
    vis(brand.e, windowFade(t, TIMING.intro, capTo, 0.5, 0.5) * (1 - 0.6 * near));

    // didascalia
    const ap = windowFade(t, capFrom, capTo, 0.5, 0.5);
    const cur = capItems.find((c) => t >= c.t0 && t < c.t1) || capItems.filter((c) => c.t0 <= t).pop() || null;
    if (cur) {
      caption.setItem(cur.item);
      const lastC = cur === capItems[capItems.length - 1];
      const t0 = Math.max(cur.t0, capFrom);
      const textA = windowFade(t, t0 - 0.001, lastC ? cur.t1 + 10 : cur.t1, 0.25, 0.15);
      const slide = (1 - EASE.out(clamp01((t - t0) / 0.5))) * 16;
      const fills = stepCaps.map((s) => (cur.kind === 'check' || t >= s.t1 ? 1 : t <= s.t0 ? 0 : clamp01((t - s.t0) / (s.t1 - s.t0))));
      caption.update(t, { a: ap, fills, curIndex: cur.kind === 'step' ? stepCaps.indexOf(cur) : -1, textA, slide });
      caption.e.style.transform = `translateY(${((1 - EASE.out(clamp01((t - capFrom) / 0.7))) * 40).toFixed(1)}px)`;
    } else vis(caption.e, 0);

    // etichette
    for (const L of labels) {
      const a = windowFade(t, L.t0, L.t1, 0.35, 0.35);
      vis(L.e, a);
      L.line.setAttribute('opacity', a.toFixed(3));
      L.dot.setAttribute('opacity', a.toFixed(3));
      if (a <= 0) continue;
      const p = project(cam, L.part.localBox.getCenter(new THREE.Vector3()).applyMatrix4(L.part.node.matrixWorld));
      const w = L.e.offsetWidth, h = L.e.offsetHeight;
      const x = p.x + L.dx, y = p.y + L.dy;
      L.e.style.left = (L.side > 0 ? x : x - w).toFixed(1) + 'px';
      L.e.style.top = (y - h / 2).toFixed(1) + 'px';
      L.line.setAttribute('x1', p.x.toFixed(1)); L.line.setAttribute('y1', p.y.toFixed(1));
      L.line.setAttribute('x2', x.toFixed(1)); L.line.setAttribute('y2', y.toFixed(1));
      L.dot.setAttribute('cx', p.x.toFixed(1)); L.dot.setAttribute('cy', p.y.toFixed(1));
    }
    if (hw) {
      const ah = windowFade(t, cw.t0 + 2.3, cw.t1 - 0.5, 0.5, 0.4);
      vis(hw, ah);
      hw.style.transform = `translateX(${((1 - EASE.out(clamp01((t - cw.t0 - 2.3) / 0.7))) * 60).toFixed(1)}px)`;
    }
    // quantita'
    for (const tg of tags) {
      const a = windowFade(t, tg.t0, tg.t1, 0.3, 0.3);
      vis(tg.e, a);
      if (a <= 0) continue;
      const b = new THREE.Box3();
      for (const k of tg.keys) { const p = model.byKey.get(k); b.union(p.localBox.clone().applyMatrix4(p.node.matrixWorld)); }
      const c = b.getCenter(new THREE.Vector3());
      let top = Infinity;
      for (const v of boxCorners(b)) top = Math.min(top, project(cam, v).y);
      const pc = project(cam, c);
      const w = tg.e.offsetWidth, h = tg.e.offsetHeight;
      const x = Math.min(1824 - w, Math.max(96, pc.x - w / 2));
      const y = Math.min(760 - h, Math.max(130, top - h - 34));
      tg.e.style.left = x.toFixed(1) + 'px';
      tg.e.style.top = y.toFixed(1) + 'px';
      tg.e.style.transform = `scale(${(0.85 + 0.15 * EASE.out(clamp01((t - tg.t0) / 0.35))).toFixed(3)})`;
    }
    end.update(windowFade(t, ch.endcard.t0, ch.duration + 10, 0.8, 0.01));
  }

  function renderAt(t) {
    poseAt(t);
    const si = shotIndexAt(t), shot = shots[si];
    const u = si > 0 && shot.dis > 0 ? (t - shot.t0) / shot.dis : 1;
    let distPrev = null;
    if (u < 1) {
      distPrev = poseCamera(camPrev, shots[si - 1], t);
      rig.setEdgeScale(1 + 0.65 * nearK(distPrev));
      for (const p of model.parts) rig.setLook(p, states.get(p.key).o, states.get(p.key).h, 0);
      updateHalos(camPrev);
      renderer.render(scene, camPrev);
      gctx.clearRect(0, 0, W, H);
      gctx.drawImage(canvas, 0, 0, W, H);
      const a = 1 - (u * u * (3 - 2 * u));
      const dp = (0.17 * nearK(distPrev)).toFixed(3);
      ghost.style.backgroundImage = `linear-gradient(rgba(150,130,110,${dp}), rgba(150,130,110,${dp})), var(--studio)`;
      ghost.style.opacity = a.toFixed(4);
      ghost.style.visibility = 'visible';
    } else ghost.style.visibility = 'hidden';
    const dist = poseCamera(camera, shot, t);
    dimEl.style.opacity = (0.17 * nearK(dist)).toFixed(3);
    rig.setEdgeScale(1 + 0.65 * nearK(dist));
    for (const p of model.parts) rig.setLook(p, states.get(p.key).o, states.get(p.key).h, 0);
    updateHalos(camera);
    const dominant = u < 0.5 ? camPrev : camera;
    overlay(t, dominant, u < 0.5 ? distPrev : dist);
    renderer.render(scene, camera);
  }

  if (ch.warnings.length) for (const w of ch.warnings) console.warn('[piano] ' + w);
  window.__debug = { scene, rig, ch, shots, camera };
  return {
    duration: ch.duration,
    posterTime: Math.min(2.6, TIMING.intro - 0.8),
    chapters: capItems.map((c) => ({ kind: c.kind, n: c.n, t0: +c.t0.toFixed(2), t1: +c.t1.toFixed(2), title: c.title })),
    warnings: ch.warnings,
    renderAt,
  };
}

/** nome breve per le etichette: prima parte prima di "di"/"in"/virgola, max ~26 caratteri */
function shortName(s) {
  const t = String(s || '').trim();
  if (t.length <= 26) return t;
  const cut = t.split(/,|\s(?:di|in|con|per|da)\s/i)[0].trim();
  return cut.length >= 6 && cut.length <= 30 ? cut : t.slice(0, 25).trim() + '…';
}
