// Rack-builder 3D rendering. Pure-ish: takes (rack record + catalogues +
// THREE namespace) and returns a THREE.Group ready to add to a scene.
//
// TWO FAMILIES:
//   • Open-frame, 4-post, NO doors / sides — Sofia Calderón's original
//     spec (RACK_OUTLOOK_DESIGN.md): two materials only, brushed steel
//     + matte-black powder coat. Amps visibly bolt to a 19" front rail
//     with cage-nut holes, frame closed at top/bottom, castor brackets.
//   • Enclosed (StarTech RK4236BKB family) — adds steel side panels,
//     perforated-steel rear door, mesh-glass front door with a real
//     openable hinge. Front door is alpha-tested perforation over a
//     tinted glass plane so the user can see the amps inside.
//
// Selected by rackDef.style ∈ {"open-frame","enclosed"}. Missing /
// undefined defaults to "open-frame" for backward compatibility with
// pre-schema-2.0 saved scenes.
//
// 1 U = 44.45 mm. Outer width 600 mm. Coordinate frame:
//   Group origin = base centre of rack (on the floor).
//   +X = rack width (right when looking at the front)
//   +Y = up
//   +Z = depth (rear-pointing). Front face is at -Z; +Z is the rear.
import * as THREE from 'three';

const U_HEIGHT_M       = 0.04445;   // 1U = 44.45 mm
const RAIL_INNER_W_MM  = 482.6;     // 19" — distance between rack rails
const RAIL_INNER_W_M   = RAIL_INNER_W_MM / 1000;

// Sofia's two-material discipline (§4 of RACK_OUTLOOK_DESIGN.md)
const COL_STEEL  = 0x52555b;
const COL_BLACK  = 0x15161a;
const STEEL_MAT  = new THREE.MeshStandardMaterial({ color: COL_STEEL, metalness: 0.78, roughness: 0.42 });
const BLACK_MAT  = new THREE.MeshStandardMaterial({ color: COL_BLACK, metalness: 0.10, roughness: 0.78 });
const TOP_CAP_MAT = new THREE.MeshStandardMaterial({ color: COL_STEEL, metalness: 0.55, roughness: 0.60 });

// ---- Enclosed-rack materials (slice 2) ----------------------------------
// One shared glass tint and a family of perforation-mask textures keyed by
// (perfPct, dotPx, tilePx). depthWrite:false on both door layers so the
// glass does not punch a hole in the depth buffer that hides the heatmap
// or selection rings behind the rack.
const GLASS_TINT_MAT = new THREE.MeshStandardMaterial({
  color: 0x9ab7c4,
  metalness: 0.05,
  roughness: 0.20,
  transparent: true,
  opacity: 0.18,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// Module-level cache: avoid rebuilding the perforation canvas every frame.
const _perfTextureCache = new Map();   // key → THREE.CanvasTexture
const _perfMaterialCache = new Map();  // key → THREE.MeshStandardMaterial (mesh overlay)
const _ventTextureCache = new Map();   // key → THREE.CanvasTexture (top vent slots)

function getPerforationTexture(perfPct, opts = {}) {
  // Tileable round-hole pattern at a given perforation_pct. Output is an
  // alphaMap: WHITE = opaque hole pattern? No — for an alphaMap, WHITE = visible
  // material, BLACK = transparent. We want the holes to be transparent (you
  // see through the door) and the surrounding metal to be opaque. So:
  // background WHITE (metal), holes BLACK (see-through).
  const dotPx  = opts.dotPx  ?? 7;
  const tilePx = opts.tilePx ?? 128;
  const key = `perf:${perfPct}:${dotPx}:${tilePx}`;
  if (_perfTextureCache.has(key)) return _perfTextureCache.get(key);

  // Hex packing maximises hole density for a given dot diameter. Compute the
  // pitch (centre-to-centre) needed to hit the requested area-fraction:
  // hex unit cell area = pitch² · √3 / 2. One hole per unit cell, hole area
  // = π · r². So pitch = r · √(2π / (perfPct · √3)).
  const r = dotPx / 2;
  const targetFrac = Math.max(0.05, Math.min(0.85, perfPct / 100));
  const pitch = r * Math.sqrt((2 * Math.PI) / (targetFrac * Math.sqrt(3)));

  const cv = document.createElement('canvas');
  cv.width = tilePx; cv.height = tilePx;
  const ctx = cv.getContext('2d');
  // Metal = white = opaque on alphaMap
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tilePx, tilePx);
  // Holes = black = transparent on alphaMap. Hex offset every other row.
  ctx.fillStyle = '#000000';
  const rowH = pitch * Math.sqrt(3) / 2;
  const cols = Math.ceil(tilePx / pitch) + 2;
  const rows = Math.ceil(tilePx / rowH) + 2;
  for (let row = -1; row < rows; row++) {
    const offsetX = (row % 2 === 0) ? 0 : pitch / 2;
    for (let col = -1; col < cols; col++) {
      const cx = col * pitch + offsetX;
      const cy = row * rowH;
      // Draw the hole and its wraps (so the tile is genuinely tileable).
      for (const dx of [0, -tilePx, tilePx]) {
        for (const dy of [0, -tilePx, tilePx]) {
          ctx.beginPath();
          ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;  // alphaMap, not colour
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _perfTextureCache.set(key, tex);
  return tex;
}

function getPerforationMaterial(perfPct, colorHex = 0x111418, opts = {}) {
  const key = `perfmat:${perfPct}:${colorHex.toString(16)}`;
  if (_perfMaterialCache.has(key)) return _perfMaterialCache.get(key);
  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    metalness: 0.70,
    roughness: 0.55,
    transparent: true,
    alphaMap: getPerforationTexture(perfPct, opts),
    opacity: 1.0,
    depthWrite: false,
    side: THREE.DoubleSide,
    alphaTest: 0.5,  // crisp hole edges — avoids translucent halo around perforations
  });
  _perfMaterialCache.set(key, mat);
  return mat;
}

// Top-cap vent slots: rectangular louvers, ~40% open. Used as an alphaMap
// on the top cap plane so we don't geometry-stamp 30+ slots.
function getTopVentTexture(ventPct) {
  const key = `vent:${ventPct}`;
  if (_ventTextureCache.has(key)) return _ventTextureCache.get(key);
  const W = 256, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';   // metal = opaque
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';   // slot = transparent
  // Centre-band of horizontal slots: open fraction ≈ ventPct/100 across the
  // band. Band height = 60% of H; remaining 40% (top + bottom) is solid.
  const bandY0 = H * 0.20;
  const bandY1 = H * 0.80;
  const bandH  = bandY1 - bandY0;
  const slotCount = 8;
  const slotH = (bandH * (ventPct / 100)) / slotCount;
  const gap = (bandH - slotCount * slotH) / (slotCount + 1);
  for (let i = 0; i < slotCount; i++) {
    const yy = bandY0 + gap + i * (slotH + gap);
    ctx.fillRect(W * 0.06, yy, W * 0.88, slotH);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  _ventTextureCache.set(key, tex);
  return tex;
}

const _ampLabelCache = new Map();
let _railTextureCache = null;
let _u1PanelCache = null;

function getAmpLabelTexture(modelName) {
  if (_ampLabelCache.has(modelName)) return _ampLabelCache.get(modelName);
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1a1a1f';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#e0e0e8';
  ctx.font = '600 36px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(modelName, 16, cv.height / 2);
  // Subtle vent stripes
  ctx.strokeStyle = '#3a3a40';
  ctx.lineWidth = 1;
  for (let y = 12; y < cv.height - 12; y += 4) {
    ctx.beginPath();
    ctx.moveTo(cv.width - 240, y);
    ctx.lineTo(cv.width - 16, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _ampLabelCache.set(modelName, tex);
  return tex;
}

// 1U-tall cage-nut hole tile. Three rounded squares centred on the rail
// face, with a faint "U-stripe" shadow at the top of every cell so the
// rail reads as 1U-quantised. wrapT=Repeat × repeat.y=uCount tiles
// it up the full rail height. Sofia spec §3.1.
function getRailTexture() {
  if (_railTextureCache) return _railTextureCache;
  // Tile size: 50 px wide × 89 px tall (≈ 25 mm × 44.45 mm aspect).
  const cv = document.createElement('canvas');
  cv.width = 50; cv.height = 89;
  const ctx = cv.getContext('2d');
  // Steel ground
  ctx.fillStyle = '#52555b';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // Faint U-divider at top of each tile (so rails read as quantised)
  ctx.strokeStyle = '#3c3f44';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(2, 0.5);
  ctx.lineTo(cv.width - 2, 0.5);
  ctx.stroke();
  // 3 rounded square cage-nut holes centred vertically: 9 mm × 9 mm
  // squares mapped to ~18 px × 18 px on this 50×89 tile.
  const holeW = 16, holeH = 16, r = 3;
  const cy = cv.height / 2 - holeH / 2;
  // First hole at top-third, third at bottom-third — matches real cage-nut convention
  const cys = [13, cy, cv.height - 13 - holeH];
  ctx.fillStyle = '#15161a';
  for (const yy of cys) {
    const xx = (cv.width - holeW) / 2;
    // rounded rect (canvas v1 fallback for older browsers)
    ctx.beginPath();
    ctx.moveTo(xx + r, yy);
    ctx.lineTo(xx + holeW - r, yy);
    ctx.quadraticCurveTo(xx + holeW, yy, xx + holeW, yy + r);
    ctx.lineTo(xx + holeW, yy + holeH - r);
    ctx.quadraticCurveTo(xx + holeW, yy + holeH, xx + holeW - r, yy + holeH);
    ctx.lineTo(xx + r, yy + holeH);
    ctx.quadraticCurveTo(xx, yy + holeH, xx, yy + holeH - r);
    ctx.lineTo(xx, yy + r);
    ctx.quadraticCurveTo(xx, yy, xx + r, yy);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearFilter; // avoid mip blur on small holes
  _railTextureCache = tex;
  return tex;
}

// "CABLE MGMT" label canvas for the U1 panel. Sofia §3.6.
function getU1PanelTexture() {
  if (_u1PanelCache) return _u1PanelCache;
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 60;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#15161a';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // Subtle perforation pattern — 6×3 grid of small dots
  ctx.fillStyle = '#1f2026';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 24; c++) {
      ctx.beginPath();
      ctx.arc(20 + c * 16, 14 + r * 16, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#9a9a9a';
  ctx.font = '600 14px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText('CABLE MGMT', cv.width - 16, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _u1PanelCache = tex;
  return tex;
}

// Build a single amplifier mesh sized for its uHeight + spec depth.
function buildAmpMesh(slot, ampDef, slotDepth_m) {
  const u = slot.uHeight ?? 1;
  const w = RAIL_INNER_W_M;             // amp fills 19" rail width
  const h = U_HEIGHT_M * u * 0.92;      // small bezel between adjacent amps
  const d = slotDepth_m;
  const group = new THREE.Group();

  // Body — colour by category (multi-channel install vs mixer-amp etc.)
  const cat = (ampDef?.category ?? []);
  let bodyHex = 0x1f2125;
  if (cat.includes('mixer-amplifier')) bodyHex = 0x2a2a32;
  if (cat.includes('Class-AB')) bodyHex = 0x2c1f1f;       // amber-tinted warning
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: bodyHex, roughness: 0.62, metalness: 0.18 }),
  );
  group.add(body);

  // Front-panel label plane (with model name texture)
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.95, h * 0.7),
    new THREE.MeshBasicMaterial({ map: getAmpLabelTexture(ampDef?.model ?? slot.amplifierId), transparent: false }),
  );
  label.position.z = d / 2 + 0.001;
  group.add(label);

  // Channel knobs along the bottom edge of the front face. Visual only.
  const ch = ampDef?.electrical?.channelCount ?? 0;
  if (ch > 0 && ch <= 12) {
    const knobMat = new THREE.MeshStandardMaterial({ color: 0x202024, roughness: 0.5, metalness: 0.4 });
    const knobR = Math.min(0.012, h * 0.18);
    const span = w * 0.55;
    const startX = -span / 2;
    for (let i = 0; i < ch; i++) {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(knobR, knobR, 0.008, 14), knobMat);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(startX + (ch === 1 ? span / 2 : (i / (ch - 1)) * span),
        -h / 2 + h * 0.18,
        d / 2 + 0.005);
      group.add(knob);
    }
  }

  // Status LEDs — green dots at top-right corner of front face.
  const ledMat = new THREE.MeshStandardMaterial({
    color: 0x18a050, emissive: 0x18a050, emissiveIntensity: 0.6, roughness: 0.4,
  });
  for (let i = 0; i < 3; i++) {
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.003, 10, 8), ledMat);
    led.position.set(w * 0.42 - i * 0.012, h * 0.3, d / 2 + 0.005);
    group.add(led);
  }

  group.userData.tag = 'rack-amp';
  group.userData.amplifierId = slot.amplifierId;
  return group;
}

// Build a single rack: open frame + every populated slot. Returns a
// THREE.Group whose origin sits on the floor at the rack's base centre.
export function buildRackGroup(rack, ampCatalog, rackCatalog) {
  const group = new THREE.Group();
  group.userData.tag = 'rack-frame';
  group.userData.rackId = rack.id;

  const rackDef = rackCatalog?.racks?.[rack.rackModelKey];
  if (!rackDef) {
    console.warn(`[rack-render] no rack definition for "${rack.rackModelKey}"`);
    return group;
  }

  const outerW    = rackDef.outer_w_mm / 1000;
  const outerD    = rackDef.outer_d_mm / 1000;
  const outerH    = rackDef.outer_h_mm / 1000;
  const postW     = (rackDef.post_section_mm ?? 40) / 1000;
  const frameTop  = (rackDef.frame_top_mm ?? 40) / 1000;
  const frameBot  = (rackDef.frame_bottom_mm ?? 40) / 1000;
  const castorH   = (rackDef.castor_h_mm ?? 0) / 1000;
  const uCount    = rackDef.u ?? 0;

  // ----- 4 vertical posts at outer corners (Sofia §2: keep) ----------
  const postH = outerH - castorH;
  const postPositions = [
    [-outerW / 2 + postW / 2, -outerD / 2 + postW / 2],
    [+outerW / 2 - postW / 2, -outerD / 2 + postW / 2],
    [-outerW / 2 + postW / 2, +outerD / 2 - postW / 2],
    [+outerW / 2 - postW / 2, +outerD / 2 - postW / 2],
  ];
  for (const [sx, sz] of postPositions) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(postW, postH, postW), STEEL_MAT);
    post.position.set(sx, castorH + postH / 2, sz);
    group.add(post);
  }

  // ----- Top + bottom horizontal beams (front + rear) ----------------
  for (const sz of [-outerD / 2 + postW / 2, outerD / 2 - postW / 2]) {
    const bb = new THREE.Mesh(
      new THREE.BoxGeometry(outerW - 2 * postW, frameBot, postW),
      STEEL_MAT,
    );
    bb.position.set(0, castorH + frameBot / 2, sz);
    group.add(bb);
    const tb = new THREE.Mesh(
      new THREE.BoxGeometry(outerW - 2 * postW, frameTop, postW),
      STEEL_MAT,
    );
    tb.position.set(0, castorH + postH - frameTop / 2, sz);
    group.add(tb);
  }

  // ----- Sofia §3.2: top crossbars front-to-rear (two beams) --------
  // 30 × 30 × (outerD − 2·postW). Reads as a "cage" rather than two
  // parallel sticks. y near top, x at outer columns.
  const topCrossH = 0.030;
  const topCrossY = outerH - frameTop / 2;
  for (const sx of [-outerW / 2 + postW / 2, outerW / 2 - postW / 2]) {
    const cb = new THREE.Mesh(
      new THREE.BoxGeometry(topCrossH, topCrossH, outerD - 2 * postW),
      STEEL_MAT,
    );
    cb.position.set(sx, topCrossY, 0);
    group.add(cb);
  }

  // ----- Sofia §3.3: top cap plate ----------------------------------
  // outerW × 6 × outerD, centred at y = outerH − 3 mm
  const capPlate = new THREE.Mesh(
    new THREE.BoxGeometry(outerW, 0.006, outerD),
    TOP_CAP_MAT,
  );
  capPlate.position.set(0, outerH - 0.003, 0);
  group.add(capPlate);

  // ----- Sofia §3.4: bottom base plate ------------------------------
  // (outerW − 2·postW) × 4 × (outerD − 2·postW), matte black.
  const basePlate = new THREE.Mesh(
    new THREE.BoxGeometry(outerW - 2 * postW, 0.004, outerD - 2 * postW),
    BLACK_MAT,
  );
  basePlate.position.set(0, castorH + frameBot + 0.002, 0);
  group.add(basePlate);

  // ----- Sofia §3.1: front 19" mounting rails (the must-not-cut) ----
  // 25 × 6 × (rail height) tall. Front pair only (rear optional).
  // Rail centre-to-centre = 465 mm so inner edge is 482.6 mm (19").
  // Cage-nut texture tiled by uCount on the front face.
  const railW = 0.025;
  const railThk = 0.006;
  const railH = postH - frameTop - frameBot;
  const railY = castorH + frameBot + railH / 2;
  // Front-post inner face is at z = -outerD/2 + postW (front side near
  // negative Z). Rails inset 18 mm BEHIND that face (toward +Z, into
  // the rack interior).
  const railZ = -outerD / 2 + postW + 0.018;
  // Rail centre-to-centre 465 mm → x = ± 232.5 mm
  const railCC = 0.465;
  const railTex = getRailTexture();

  for (const sx of [-railCC / 2, railCC / 2]) {
    // Two railsets per side: a steel core (back), and a textured front
    // plane carrying the cage-nut holes (so the holes read crisply
    // without paying the cost of stamped geometry).
    const railCore = new THREE.Mesh(
      new THREE.BoxGeometry(railW, railH, railThk),
      STEEL_MAT,
    );
    railCore.position.set(sx, railY, railZ);
    group.add(railCore);

    // Front-face texture plane: same width, slightly proud of the core.
    // Tile vertically by uCount so each U gets one cage-nut tile.
    const railFaceTex = railTex.clone();
    railFaceTex.needsUpdate = true;
    railFaceTex.wrapT = THREE.RepeatWrapping;
    railFaceTex.repeat.set(1, uCount);
    const railFace = new THREE.Mesh(
      new THREE.PlaneGeometry(railW, railH),
      new THREE.MeshStandardMaterial({
        map: railFaceTex, metalness: 0.55, roughness: 0.55, color: 0xffffff,
      }),
    );
    railFace.position.set(sx, railY, railZ - railThk / 2 - 0.0005);
    group.add(railFace);
  }

  // ----- Sofia §3.6: U1 cable-management panel ---------------------
  // RAIL_INNER_W × U_HEIGHT × 12 mm matte black panel between front
  // rails at U1 centre.
  const u1Y = castorH + frameBot + U_HEIGHT_M / 2;
  const u1Panel = new THREE.Mesh(
    new THREE.BoxGeometry(RAIL_INNER_W_M, U_HEIGHT_M * 0.92, 0.012),
    BLACK_MAT,
  );
  u1Panel.position.set(0, u1Y, railZ);
  group.add(u1Panel);
  // Label face — front of the panel, slightly proud
  const u1Label = new THREE.Mesh(
    new THREE.PlaneGeometry(RAIL_INNER_W_M, U_HEIGHT_M * 0.92),
    new THREE.MeshBasicMaterial({ map: getU1PanelTexture() }),
  );
  u1Label.position.set(0, u1Y, railZ - 0.012 / 2 - 0.0006);
  group.add(u1Label);

  // ----- Sofia §3.5: castor brackets + bolt-stem + wheel ------------
  if (rackDef.castors) {
    const bracketH = 0.030;        // 30 mm housing (less than castorH so wheel shows)
    const bracketSize = 0.060;     // 60 × 40 × 60 housing
    for (const sx of [-outerW / 2 + 0.06, outerW / 2 - 0.06]) {
      for (const sz of [-outerD / 2 + 0.06, outerD / 2 - 0.06]) {
        // Stem connects bottom-frame to bracket top
        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.008, 0.008, castorH - bracketH, 12),
          STEEL_MAT,
        );
        stem.position.set(sx, castorH - (castorH - bracketH) / 2 - bracketH, sz);
        group.add(stem);
        // Bracket (matte-black cube housing)
        const bracket = new THREE.Mesh(
          new THREE.BoxGeometry(bracketSize, bracketH, 0.040),
          BLACK_MAT,
        );
        bracket.position.set(sx, bracketH / 2 + 0.02, sz);
        group.add(bracket);
        // Wheel: black cylinder, axis horizontal
        const wheelR = (castorH - bracketH - 0.005) / 2;
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(wheelR, wheelR, 0.030, 18),
          BLACK_MAT,
        );
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx, wheelR + 0.005, sz);
        group.add(wheel);
      }
    }
  }

  // ----- Slots — populated amps live inside the post-bounded volume -
  const innerY0 = castorH + frameBot + U_HEIGHT_M;  // U1 starts above the cable panel
  const slotDepth = (rackDef.depth_for_amps_m ?? (outerD - 2 * postW - 0.04));
  const ampList = Array.isArray(ampCatalog) ? ampCatalog : [];
  const findAmp = (id) => ampList.find(a => a.id === id);
  const slots = Array.isArray(rack.slots) ? rack.slots : [];
  for (const slot of slots) {
    if ((slot.uStart ?? 0) < 1) continue; // skip U1 reserved for cable mgmt
    const ampDef = findAmp(slot.amplifierId);
    const u = slot.uHeight ?? 1;
    const yBase = innerY0 + (slot.uStart - 2) * U_HEIGHT_M; // U2 → first available
    const yCentre = yBase + (U_HEIGHT_M * u) / 2;
    const ampGroup = buildAmpMesh(slot, ampDef, slotDepth);
    // Rails are at z = railZ (front-side, negative Z); amp body sits
    // BEHIND the rail front face by a little so the amp's front panel
    // is flush with the rail front face.
    ampGroup.position.set(0, yCentre, railZ + slotDepth / 2 - railThk);
    group.add(ampGroup);
  }

  // ===== Enclosed-style add-ons (slice 2) ===========================
  // Defensive: missing field → open-frame. New scenes carry style:"enclosed".
  const style = rackDef.style ?? 'open-frame';
  if (style === 'enclosed') {
    addEnclosedShell(group, rack, rackDef, {
      outerW, outerD, outerH, postW, frameTop, frameBot, castorH, postH, railZ,
    });
  }

  return group;
}

// ---- Enclosed shell: side panels + top vent + rear door + front door ----
function addEnclosedShell(group, rack, rackDef, geom) {
  const { outerW, outerD, outerH, postW, frameTop, frameBot, castorH, postH } = geom;

  // Front face is at z = -outerD/2 + postW (outer face of the front post).
  // Rear face is at z = +outerD/2 - postW (outer face of the rear post).
  const frontZ = -outerD / 2 + postW;
  const rearZ  = +outerD / 2 - postW;

  // Vertical extent of the closed shell — sits between top-frame and the
  // base plate, hugging the post inner faces.
  const shellY0 = castorH + frameBot;
  const shellY1 = castorH + postH - frameTop;
  const shellH  = shellY1 - shellY0;
  const shellYc = (shellY0 + shellY1) / 2;

  // ---- Side panels (left + right) --------------------------------------
  // Two thin solid panels flush with the outer face of the side posts.
  // Inset 1 mm so the seam against the posts is visible. Span post-to-post
  // along depth so the panel does not poke through the front/rear face.
  if (rackDef.side_panels !== false) {
    const sideThk = 0.003;           // 3 mm sheet
    const sideD   = outerD - 2 * postW;   // sits between the two depth-direction posts
    for (const sxSign of [-1, +1]) {
      const sx = sxSign * (outerW / 2 - sideThk / 2 - 0.001);   // 1 mm inset from post outer face
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(sideThk, shellH, sideD),
        BLACK_MAT,
      );
      panel.position.set(sx, shellYc, 0);
      panel.userData.tag = 'rack-side-panel';
      group.add(panel);
    }
  }

  // ---- Top cap vent strip ---------------------------------------------
  // The legacy builder already drew a solid steel cap plate at y = outerH - 3 mm.
  // For enclosed cabinets the user expects a vent strip across the top.
  // Overlay a perforation plane on top of the cap, ~2 mm proud, alpha-tested
  // by the slot pattern. We don't remove the underlying cap — the alphaMap
  // is the vent; the cap below it stays solid steel (acoustically tight).
  // To make the vent VISIBLE, we drop a darker plane *inside* the rack at
  // top-Y showing through the slots when looked at from above.
  const ventPct = Math.max(0, Math.min(100, rackDef.vent_top_pct ?? 40));
  if (ventPct > 0) {
    const ventTex = getTopVentTexture(ventPct);
    const ventMat = new THREE.MeshStandardMaterial({
      color: 0x52555b,
      metalness: 0.55, roughness: 0.55,
      transparent: true, alphaMap: ventTex, alphaTest: 0.5,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    const ventW = outerW * 0.86;
    const ventD = outerD * 0.30;
    const ventPlane = new THREE.Mesh(new THREE.PlaneGeometry(ventW, ventD), ventMat);
    ventPlane.rotation.x = -Math.PI / 2;
    ventPlane.position.set(0, outerH + 0.001, 0);   // 1 mm above existing cap plate
    ventPlane.userData.tag = 'rack-top-vent';
    group.add(ventPlane);

    // Dark inner cavity plane just below the cap so the vent slots read as
    // openings (not as black lines on a steel plate).
    const cavity = new THREE.Mesh(
      new THREE.PlaneGeometry(ventW * 0.95, ventD * 0.95),
      new THREE.MeshBasicMaterial({ color: 0x05060a, side: THREE.DoubleSide }),
    );
    cavity.rotation.x = -Math.PI / 2;
    cavity.position.set(0, outerH - 0.010, 0);
    group.add(cavity);
  }

  // ---- Rear door — perforated steel -----------------------------------
  // Full-back panel covering the opening between the two rear posts.
  // ~10 mm inset toward the rack interior (-Z from the post outer face)
  // so the door reads as a recessed panel, not flush with the post.
  const rearDoorDef = rackDef.rear_door ?? {};
  if (rearDoorDef.type && rearDoorDef.type !== 'none') {
    const rearPct = rearDoorDef.perforation_pct ?? 50;
    const doorW = outerW - 2 * postW + 0.002;   // span between posts, slight overlap
    const doorH = shellH;
    // Repeat the perforation tile across the door surface — about 18 mm per tile
    // → repeat counts scale with door dimensions.
    const tilePerM = 1 / 0.018;
    const rearMat = getPerforationMaterial(rearPct, 0x1a1c20).clone();
    rearMat.alphaMap = getPerforationTexture(rearPct).clone();
    rearMat.alphaMap.wrapS = THREE.RepeatWrapping;
    rearMat.alphaMap.wrapT = THREE.RepeatWrapping;
    rearMat.alphaMap.repeat.set(doorW * tilePerM, doorH * tilePerM);
    rearMat.alphaMap.needsUpdate = true;
    rearMat.alphaTest = 0.5;
    rearMat.needsUpdate = true;
    const rearDoor = new THREE.Mesh(
      new THREE.PlaneGeometry(doorW, doorH),
      rearMat,
    );
    rearDoor.rotation.y = Math.PI;  // face outward (-Z normal → +Z normal)
    rearDoor.position.set(0, shellYc, rearZ - 0.010);
    rearDoor.userData.tag = 'rack-rear-door';
    group.add(rearDoor);
  }

  // ---- Front door — mesh-glass, HINGED --------------------------------
  // Hinged child group; hinge axis runs vertically along the inner edge of
  // the LEFT front post (state-frame x = -outerW/2 + postW). When
  // rack.doorOpen is true, the group rotates -100° about its local Y axis
  // (swings outward toward the viewer, i.e. toward -Z). When closed, 0°.
  const frontDoorDef = rackDef.front_door ?? {};
  if (frontDoorDef.type && frontDoorDef.type !== 'none') {
    const hingeX = -outerW / 2 + postW;
    const doorOpenW = outerW - 2 * postW;      // post-to-post in X
    const doorOpenH = shellH;
    const doorThk = 0.006;                      // door frame depth

    const doorGroup = new THREE.Group();
    doorGroup.userData.tag = 'rack-front-door-hinge';
    doorGroup.userData.rackId = rack.id;
    // Position the hinge at the left-inner-front corner of the opening.
    // The door's local origin = hinge; geometry built so the door extends
    // from x=0 (hinge) to x=+doorOpenW (free edge), and z=0 (door plane).
    doorGroup.position.set(hingeX, shellYc, frontZ + doorThk / 2 + 0.002);

    // Apply open/closed rotation. -100° = swing outward toward viewer (-Z).
    const isOpen = !!rack.doorOpen;
    doorGroup.rotation.y = isOpen ? -(100 * Math.PI / 180) : 0;
    doorGroup.userData.doorOpen = isOpen;

    // --- Glass tint plane (back layer; inside the perforation overlay) ---
    // Centred on x=+doorOpenW/2 (door extends from hinge to free edge in +x).
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(doorOpenW - 0.004, doorOpenH - 0.004),
      GLASS_TINT_MAT,
    );
    glass.position.set(doorOpenW / 2, 0, -doorThk / 2 + 0.001);
    glass.userData.tag = 'rack-front-door-glass';
    glass.userData.no_walk_collide = true;
    glass.renderOrder = 1;  // after opaque, before perforation overlay
    doorGroup.add(glass);

    // --- Mesh perforation overlay (front layer; toward viewer) ---
    // CLONE the cached material + alphaMap so we can tile this door's
    // perforation density independently of the rear door's.
    const frontPct = frontDoorDef.perforation_pct ?? 63;
    const meshMat = getPerforationMaterial(frontPct, 0x111418).clone();
    meshMat.alphaMap = getPerforationTexture(frontPct).clone();
    meshMat.alphaMap.wrapS = THREE.RepeatWrapping;
    meshMat.alphaMap.wrapT = THREE.RepeatWrapping;
    // ~16 mm per tile → fine mesh that reads as a screen up close and as
    // a tinted surface at room scale.
    const meshTilePerM = 1 / 0.016;
    meshMat.alphaMap.repeat.set(doorOpenW * meshTilePerM, doorOpenH * meshTilePerM);
    meshMat.alphaMap.needsUpdate = true;
    meshMat.needsUpdate = true;
    const meshPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(doorOpenW - 0.002, doorOpenH - 0.002),
      meshMat,
    );
    meshPlane.position.set(doorOpenW / 2, 0, +doorThk / 2);
    meshPlane.userData.tag = 'rack-front-door-mesh';
    meshPlane.userData.no_walk_collide = true;
    meshPlane.renderOrder = 2;
    doorGroup.add(meshPlane);

    // --- Door frame (thin black bezel around the glass) ------------------
    // Four 8 mm bars. Gives the door a rigid silhouette in the closed state
    // and a visible "swung-out rectangle" when open.
    const bezelMat = BLACK_MAT;
    const bezelW = 0.008;
    const bars = [
      // top
      { w: doorOpenW, h: bezelW, x: doorOpenW / 2, y: +doorOpenH / 2 - bezelW / 2 },
      // bottom
      { w: doorOpenW, h: bezelW, x: doorOpenW / 2, y: -doorOpenH / 2 + bezelW / 2 },
      // hinge side (left, x=0)
      { w: bezelW, h: doorOpenH, x: bezelW / 2, y: 0 },
      // free side (right)
      { w: bezelW, h: doorOpenH, x: doorOpenW - bezelW / 2, y: 0 },
    ];
    for (const b of bars) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(b.w, b.h, doorThk),
        bezelMat,
      );
      bar.position.set(b.x, b.y, 0);
      bar.userData.no_walk_collide = true;
      doorGroup.add(bar);
    }

    // --- Handle on the free (right) edge ---------------------------------
    // Small vertical black bar, ~80 mm tall × 8 mm diameter, standing out
    // about 18 mm proud of the mesh face. Positioned at mid-height, 50 mm
    // in from the free edge so it doesn't clip the bezel.
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.080, 14),
      new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.55, roughness: 0.45 }),
    );
    handle.position.set(doorOpenW - 0.050, 0, doorThk / 2 + 0.018);
    handle.userData.tag = 'rack-front-door-handle';
    handle.userData.no_walk_collide = true;
    doorGroup.add(handle);
    // Two short standoffs that visually carry the handle (top + bottom).
    for (const yy of [-0.045, +0.045]) {
      const standoff = new THREE.Mesh(
        new THREE.CylinderGeometry(0.003, 0.003, 0.018, 10),
        new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.55, roughness: 0.45 }),
      );
      standoff.rotation.x = Math.PI / 2;
      standoff.position.set(doorOpenW - 0.050, yy, doorThk / 2 + 0.009);
      standoff.userData.no_walk_collide = true;
      doorGroup.add(standoff);
    }

    group.add(doorGroup);
  }
}

export const RACK_RENDER_CONSTANTS = Object.freeze({
  U_HEIGHT_M,
  RAIL_INNER_W_M,
});
