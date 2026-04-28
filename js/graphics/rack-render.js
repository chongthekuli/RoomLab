// Rack-builder 3D rendering. Pure-ish: takes (rack record + catalogues +
// THREE namespace) and returns a THREE.Group ready to add to a scene.
//
// Open-frame, 4-post, NO doors / sides. Outlook spec by Sofia Calderón
// (RACK_OUTLOOK_DESIGN.md): two materials only — brushed steel +
// matte-black powder coat. The amps visibly bolt to a 19" front rail
// with cage-nut holes (Sofia's "must not cut"), the frame is closed at
// the top and bottom so it stops reading as scaffolding, and the
// castors carry visible mounting brackets instead of bare cylinders.
//
// 1 U = 44.45 mm. Outer width 600 mm. Coordinate frame:
//   Group origin = base centre of rack (on the floor).
//   +X = rack width (right when looking at the front)
//   +Y = up
//   +Z = depth (rear-pointing). Front face normal is +Z.
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

  return group;
}

export const RACK_RENDER_CONSTANTS = Object.freeze({
  U_HEIGHT_M,
  RAIL_INNER_W_M,
});
