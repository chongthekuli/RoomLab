import * as THREE from 'three';

// Procedural material textures for the 3D viewport. Each material id (from
// data/materials.json + a few architectural extras) gets its own canvas
// pattern; surfaces of any size wrap the canvas with THREE.RepeatWrapping.
//
// Design goals:
//   - No external image assets — everything is drawn programmatically, so
//     the project stays zero-dependency and works offline.
//   - One canvas per material (shared across all surfaces that use it) for
//     memory. Each surface gets its own lightweight THREE.Texture wrapping
//     the shared canvas, so per-surface `repeat` can differ.
//   - A canvas tile represents a fixed physical area per material (e.g. 1 m
//     for wood planks, 1.2 m for acoustic tile). Callers pass physical
//     dimensions in meters; the helper computes the correct repeat count.

const CANVAS_SIZE = 256;
const canvasCache = new Map();   // materialId → HTMLCanvasElement
const paletteCache = new Map();  // materialId → { tint, roughness, metalness }

// How many meters of real wall/floor/ceiling one canvas tile represents.
// Tuned so features read at realistic scale: planks ~0.2 m tall, ceiling
// tiles ~0.6 m square, bricks ~0.24 m × 0.075 m, etc.
const METERS_PER_TILE = {
  'wood-floor':       0.8,
  'concrete-painted': 1.2,
  'concrete':         1.5,
  'carpet-heavy':     0.6,
  'carpet':           0.6,
  'acoustic-tile':    1.2,
  'gypsum-board':     2.0,
  'glass-window':     1.6,
  'brick':            1.0,
  'steel':            0.8,
};

function getCanvas(materialId) {
  if (canvasCache.has(materialId)) return canvasCache.get(materialId);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  paintMaterial(ctx, materialId);
  canvasCache.set(materialId, canvas);
  return canvas;
}

export function getMaterialPalette(materialId) {
  if (paletteCache.has(materialId)) return paletteCache.get(materialId);
  getCanvas(materialId); // triggers palette assignment
  return paletteCache.get(materialId) ?? { tint: 0xffffff, roughness: 0.85, metalness: 0.05 };
}

// Main helper: returns a THREE.CanvasTexture scaled so the procedural pattern
// repeats at the material's natural tile size across a surface of the given
// real-world dimensions.
export function getMaterialTexture(materialId, widthM, heightM) {
  const canvas = getCanvas(materialId);
  const perTile = METERS_PER_TILE[materialId] ?? 1.0;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.repeat.set(
    Math.max(0.5, (widthM || 1) / perTile),
    Math.max(0.5, (heightM || 1) / perTile),
  );
  return tex;
}

function paintMaterial(ctx, id) {
  switch (id) {
    case 'wood-floor':       paintWoodFloor(ctx); break;
    case 'concrete-painted': paintConcretePainted(ctx); break;
    case 'concrete':         paintConcrete(ctx); break;
    case 'carpet-heavy':
    case 'carpet':           paintCarpet(ctx); break;
    case 'acoustic-tile':    paintAcousticTile(ctx); break;
    case 'gypsum-board':     paintGypsumBoard(ctx); break;
    case 'glass-window':     paintGlass(ctx); break;
    case 'brick':            paintBrick(ctx); break;
    case 'steel':            paintSteel(ctx); break;
    default:                 paintGypsumBoard(ctx); break;
  }
}

// Deterministic pseudo-random so patterns are stable across reloads.
// The cached canvas only regenerates once per material.
function mulberry(seed) {
  let t = seed;
  return () => {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function paintWoodFloor(ctx) {
  paletteCache.set('wood-floor', { tint: 0xffffff, roughness: 0.6, metalness: 0.05 });
  const rand = mulberry(1001);
  // Warmer, richer brown base — reads as wood at arena distance.
  ctx.fillStyle = '#7a5028';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const plankH = 64;
  for (let p = 0; p < 4; p++) {
    const y = p * plankH;
    const shade = 0.75 + rand() * 0.35;
    const r = Math.floor(160 * shade), g = Math.floor(108 * shade), b = Math.floor(55 * shade);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, y, CANVAS_SIZE, plankH - 2);
    // Stronger grain lines — more visible from camera distance.
    ctx.strokeStyle = 'rgba(55, 32, 12, 0.55)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      const yy = y + 4 + rand() * (plankH - 8);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(
        64, yy + (rand() - 0.5) * 3,
        192, yy + (rand() - 0.5) * 3,
        CANVAS_SIZE, yy + (rand() - 0.5) * 3,
      );
      ctx.stroke();
    }
    // Knots — random dark circular marks
    if (rand() < 0.6) {
      const kx = rand() * CANVAS_SIZE, ky = y + 8 + rand() * (plankH - 18);
      const kr = 3 + rand() * 4;
      const grad = ctx.createRadialGradient(kx, ky, 0, kx, ky, kr);
      grad.addColorStop(0, 'rgba(40, 22, 8, 0.9)');
      grad.addColorStop(1, 'rgba(40, 22, 8, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(kx - kr, ky - kr, 2 * kr, 2 * kr);
    }
    // Dark plank seam
    ctx.fillStyle = '#2a1808';
    ctx.fillRect(0, y + plankH - 2, CANVAS_SIZE, 2);
    const jointX = (p % 2 === 0) ? 170 : 85;
    ctx.fillRect(jointX, y, 2, plankH - 2);
  }
}

function paintConcretePainted(ctx) {
  paletteCache.set('concrete-painted', { tint: 0xffffff, roughness: 0.85, metalness: 0.05 });
  const rand = mulberry(2002);
  // Warmer sand/beige concrete instead of flat gray — reads as a real
  // painted surface at arena distance.
  ctx.fillStyle = '#c8bfa8';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  // Larger, more pronounced staining patches
  for (let i = 0; i < 10; i++) {
    const cx = rand() * CANVAS_SIZE, cy = rand() * CANVAS_SIZE, r = 50 + rand() * 90;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const darkA = 0.15 + rand() * 0.15;
    grad.addColorStop(0, `rgba(130, 120, 100, ${darkA})`);
    grad.addColorStop(1, 'rgba(130, 120, 100, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  // Expansion joints — thin darker lines every ~1.2 m of the texture
  ctx.strokeStyle = 'rgba(70, 62, 50, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_SIZE / 2);
  ctx.lineTo(CANVAS_SIZE, CANVAS_SIZE / 2);
  ctx.moveTo(CANVAS_SIZE / 2, 0);
  ctx.lineTo(CANVAS_SIZE / 2, CANVAS_SIZE);
  ctx.stroke();
  // Speckle (aggregate)
  for (let i = 0; i < 1500; i++) {
    const x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    const s = 140 + Math.floor(rand() * 80);
    const g = s - 8 - Math.floor(rand() * 15);
    ctx.fillStyle = `rgba(${s}, ${g}, ${g - 10}, 0.4)`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function paintConcrete(ctx) {
  paletteCache.set('concrete', { tint: 0xffffff, roughness: 0.9, metalness: 0.03 });
  const rand = mulberry(3003);
  ctx.fillStyle = '#8c8c85';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  for (let i = 0; i < 10; i++) {
    const cx = rand() * CANVAS_SIZE, cy = rand() * CANVAS_SIZE, r = 30 + rand() * 70;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(100, 100, 92, 0.18)');
    grad.addColorStop(1, 'rgba(100, 100, 92, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  for (let i = 0; i < 1400; i++) {
    const x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    const s = 90 + Math.floor(rand() * 80);
    ctx.fillStyle = `rgba(${s}, ${s}, ${s - 3}, 0.35)`;
    ctx.fillRect(x, y, 1, 1);
  }
  // Thin crack lines
  ctx.strokeStyle = 'rgba(60, 60, 55, 0.3)';
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 3; i++) {
    let x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 20; k++) {
      x += (rand() - 0.5) * 20;
      y += (rand() - 0.5) * 20;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function paintCarpet(ctx) {
  paletteCache.set('carpet-heavy', { tint: 0xffffff, roughness: 0.98, metalness: 0.0 });
  paletteCache.set('carpet', { tint: 0xffffff, roughness: 0.98, metalness: 0.0 });
  const rand = mulberry(4004);
  // Dark burgundy base — typical arena/theater carpet
  ctx.fillStyle = '#5a2c24';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  // Fibrous grain: many short strokes
  for (let i = 0; i < 4500; i++) {
    const x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    const r = 70 + Math.floor(rand() * 60);
    const g = 30 + Math.floor(rand() * 30);
    const b = 24 + Math.floor(rand() * 20);
    const alpha = 0.35 + rand() * 0.3;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 3, y + (rand() - 0.5) * 3);
    ctx.stroke();
  }
}

function paintAcousticTile(ctx) {
  paletteCache.set('acoustic-tile', { tint: 0xffffff, roughness: 0.95, metalness: 0.0 });
  const rand = mulberry(5005);
  ctx.fillStyle = '#e8e5da';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  // 2×2 grid of tiles (so a 1.2 m canvas tile → 0.6 m ceiling tiles)
  ctx.strokeStyle = '#9a958a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 128); ctx.lineTo(CANVAS_SIZE, 128);
  ctx.moveTo(128, 0); ctx.lineTo(128, CANVAS_SIZE);
  ctx.stroke();
  ctx.strokeRect(1, 1, CANVAS_SIZE - 2, CANVAS_SIZE - 2);
  // Small perforations / fissures
  ctx.fillStyle = '#b8b3a4';
  for (let i = 0; i < 380; i++) {
    const x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    ctx.fillRect(x, y, 1, 1);
  }
  // Subtle long fissures (mineral fiber tile look)
  ctx.strokeStyle = 'rgba(150, 145, 130, 0.35)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 18; i++) {
    const x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 40, y + (rand() - 0.5) * 6);
    ctx.stroke();
  }
}

function paintGypsumBoard(ctx) {
  paletteCache.set('gypsum-board', { tint: 0xffffff, roughness: 0.9, metalness: 0.0 });
  const rand = mulberry(6006);
  // Warmer off-white base — reads as painted drywall, not "dead gray".
  ctx.fillStyle = '#e6e0d2';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  // Visible board seams (standard 4×8 ft gypsum sheets → seams at ~1.2 m in
  // the tile, shown as soft horizontal/vertical joint lines).
  ctx.strokeStyle = 'rgba(180, 170, 150, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_SIZE / 2);
  ctx.lineTo(CANVAS_SIZE, CANVAS_SIZE / 2);
  ctx.stroke();
  // Fastener dimples (drywall screw heads) along the seam
  ctx.fillStyle = 'rgba(160, 150, 130, 0.5)';
  for (let i = 0; i < 12; i++) {
    const sx = (i / 12) * CANVAS_SIZE + 8;
    ctx.fillRect(sx, CANVAS_SIZE / 2 - 1, 2, 2);
  }
  // Paint-stippled noise
  for (let i = 0; i < 2200; i++) {
    const x = rand() * CANVAS_SIZE, y = rand() * CANVAS_SIZE;
    const s = 210 + Math.floor(rand() * 40);
    ctx.fillStyle = `rgba(${s}, ${s - 4}, ${s - 14}, 0.32)`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function paintGlass(ctx) {
  paletteCache.set('glass-window', { tint: 0xffffff, roughness: 0.1, metalness: 0.0 });
  const rand = mulberry(7007);
  const grad = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  grad.addColorStop(0, '#b8d6e4');
  grad.addColorStop(0.5, '#d2e6ef');
  grad.addColorStop(1, '#a8c8d8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  // Thin aluminum frame around the "pane"
  ctx.strokeStyle = '#6a6d74';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, CANVAS_SIZE - 4, CANVAS_SIZE - 4);
  // Light streaks
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const x = rand() * CANVAS_SIZE;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand() - 0.5) * 30, CANVAS_SIZE);
    ctx.stroke();
  }
}

function paintBrick(ctx) {
  paletteCache.set('brick', { tint: 0xffffff, roughness: 0.9, metalness: 0.0 });
  const rand = mulberry(8008);
  ctx.fillStyle = '#3a1a10';  // mortar
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const bw = 64, bh = 32;
  for (let row = 0; row < 8; row++) {
    const offset = (row % 2 === 0) ? 0 : bw / 2;
    for (let col = -1; col < 5; col++) {
      const x = col * bw + offset + 2;
      const y = row * bh + 2;
      const shade = 0.85 + rand() * 0.3;
      const r = Math.floor(138 * shade), g = Math.floor(54 * shade), b = Math.floor(34 * shade);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(x, y, bw - 4, bh - 4);
    }
  }
}

function paintSteel(ctx) {
  paletteCache.set('steel', { tint: 0xffffff, roughness: 0.35, metalness: 0.85 });
  const rand = mulberry(9009);
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_SIZE);
  grad.addColorStop(0, '#6e7177');
  grad.addColorStop(0.5, '#8e9198');
  grad.addColorStop(1, '#6a6d74');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  for (let i = 0; i < 90; i++) {
    const y = rand() * CANVAS_SIZE;
    ctx.strokeStyle = `rgba(20, 22, 26, ${rand() * 0.12})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rand() * 20, y);
    ctx.lineTo(CANVAS_SIZE - rand() * 20, y);
    ctx.stroke();
  }
}
