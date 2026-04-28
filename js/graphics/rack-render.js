// Rack-builder 3D rendering. Pure-ish: takes (rack record + catalogues +
// THREE namespace) and returns a THREE.Group ready to add to a scene.
//
// Open-frame, 4-post, no doors / sides per Felix Brandt's RACK_BUILDER
// _DESIGN.md §6. 1 U = 44.45 mm. Outer width 600 mm.
//
// Coordinate frame for the returned Group:
//   Group origin = base centre of rack (on the floor).
//   +X = rack width (right when looking at the front)
//   +Y = up
//   +Z = depth (rear-pointing). Front face normal is +Z (cabinet front).
//
// Caller positions the Group in world space and applies yaw rotation if
// the rack should face a particular wall.
import * as THREE from 'three';

const U_HEIGHT_M = 0.04445;     // 1U = 44.45 mm
const RAIL_INNER_W_MM = 482.6;  // 19" — distance between rack rails
const RAIL_INNER_W_M = RAIL_INNER_W_MM / 1000;

const _ampLabelCache = new Map();

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

// Build a single amplifier mesh sized for its uHeight + spec depth.
function buildAmpMesh(slot, ampDef, slotDepth_m, ampMaterials) {
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
      knob.rotation.x = Math.PI / 2;       // axis pointing forward
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

// Build a single rack: open frame + every populated slot rendered as
// an amp mesh at its U-position. Returns a THREE.Group whose origin
// sits on the floor at the rack's base centre.
export function buildRackGroup(rack, ampCatalog, rackCatalog) {
  const group = new THREE.Group();
  group.userData.tag = 'rack-frame';
  group.userData.rackId = rack.id;

  const rackDef = rackCatalog?.racks?.[rack.rackModelKey];
  if (!rackDef) {
    console.warn(`[rack-render] no rack definition for "${rack.rackModelKey}"`);
    return group;
  }

  const outerW = rackDef.outer_w_mm / 1000;
  const outerD = rackDef.outer_d_mm / 1000;
  const outerH = rackDef.outer_h_mm / 1000;
  const postW = (rackDef.post_section_mm ?? 40) / 1000;
  const frameTop = (rackDef.frame_top_mm ?? 40) / 1000;
  const frameBottom = (rackDef.frame_bottom_mm ?? 40) / 1000;
  const castorH = (rackDef.castor_h_mm ?? 0) / 1000;

  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x3a3d42, roughness: 0.5, metalness: 0.85,
  });
  const castorMat = new THREE.MeshStandardMaterial({
    color: 0x0d0d0f, roughness: 0.7, metalness: 0.05,
  });

  // 4 vertical posts at outer corners
  const postH = outerH - castorH;
  for (const sx of [-outerW / 2 + postW / 2, outerW / 2 - postW / 2]) {
    for (const sz of [-outerD / 2 + postW / 2, outerD / 2 - postW / 2]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(postW, postH, postW),
        frameMat,
      );
      post.position.set(sx, castorH + postH / 2, sz);
      group.add(post);
    }
  }
  // Top and bottom horizontal beams (front+rear pairs)
  for (const sz of [-outerD / 2 + postW / 2, outerD / 2 - postW / 2]) {
    // bottom beam
    const bb = new THREE.Mesh(
      new THREE.BoxGeometry(outerW - 2 * postW, frameBottom, postW),
      frameMat,
    );
    bb.position.set(0, castorH + frameBottom / 2, sz);
    group.add(bb);
    // top beam
    const tb = new THREE.Mesh(
      new THREE.BoxGeometry(outerW - 2 * postW, frameTop, postW),
      frameMat,
    );
    tb.position.set(0, castorH + postH - frameTop / 2, sz);
    group.add(tb);
  }
  // Castors at the four bottom corners (cylinders rotated to roll-axis)
  if (rackDef.castors) {
    for (const sx of [-outerW / 2 + 0.06, outerW / 2 - 0.06]) {
      for (const sz of [-outerD / 2 + 0.06, outerD / 2 - 0.06]) {
        const c = new THREE.Mesh(
          new THREE.CylinderGeometry(castorH * 0.5, castorH * 0.5, 0.04, 18),
          castorMat,
        );
        c.rotation.z = Math.PI / 2;       // axis horizontal so it reads as a wheel
        c.position.set(sx, castorH * 0.5, sz);
        group.add(c);
      }
    }
  }

  // Slots — populated amps live inside the post-bounded inner volume
  const slotZoneZ = 0; // amps centred fore-aft inside frame
  const innerY0 = castorH + frameBottom; // U1 starts here
  const slotDepth = (rackDef.depth_for_amps_m ?? (outerD - 2 * postW - 0.04));
  const ampList = ampCatalog?.find ? ampCatalog : (ampCatalog?.amps ?? []);
  const findAmp = (id) => (Array.isArray(ampList) ? ampList.find(a => a.id === id) : null);
  const slots = Array.isArray(rack.slots) ? rack.slots : [];
  for (const slot of slots) {
    const ampDef = findAmp(slot.amplifierId);
    const u = slot.uHeight ?? 1;
    const yBase = innerY0 + (slot.uStart - 1) * U_HEIGHT_M;
    const yCentre = yBase + (U_HEIGHT_M * u) / 2;
    const ampGroup = buildAmpMesh(slot, ampDef, slotDepth);
    ampGroup.position.set(0, yCentre, slotZoneZ);
    group.add(ampGroup);
  }

  return group;
}

export const RACK_RENDER_CONSTANTS = Object.freeze({
  U_HEIGHT_M,
  RAIL_INNER_W_M,
});
