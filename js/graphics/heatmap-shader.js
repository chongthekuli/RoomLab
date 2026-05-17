// js/graphics/heatmap-shader.js
//
// Scalar-field heatmap material — bilinear-interpolates SPL (or STI)
// SCALAR values, then applies the colour palette in a fragment shader.
//
// The previous CanvasTexture-based path baked the palette into the
// texture at cell resolution, then asked the GPU to bilinear-blend
// the resulting RGB texels. That produces:
//   * Stair-step boundaries because the texel grid shows through
//   * Muddy intermediate colours at the boundary of cool/warm cells
//     (e.g. teal/purple where green should fade to yellow)
//
// The correct pipeline order is what SoundPLAN / Treble / EASE-Focus
// all do:
//   1. Store SPL (or STI) values in a single-channel scalar texture
//   2. GPU bilinear-blends the SCALAR across neighbouring texels
//   3. Custom fragment shader looks up the palette AFTER interpolation
//
// Same compute cost; dramatically smoother visual output. Combined
// with the per-band Maekawa + wedge diffraction physics from Tier 1a,
// this brings the heatmap visual close to SoundPLAN / dBmap quality.
//
// References:
//   * Viktor (3D rendering expert) Tier 1a commit (f) audit, 2026-05-17
//   * SoundPLAN scalar+palette texture pipeline (Datakustik docs)
//   * Treble surface-receivers bilinear interpolation (docs.treble.tech)

import * as THREE from 'three';
import { splColorRGB, stiColorRGB } from './colour-ramps.js';

// SPL palette domain (matches splColorRGB + splColor in room-2d.js).
// Domain [30, 110] dB so outside-room SPL with Tier 1a diffraction
// physics (~58-71 dB behind a wall) shows visible gradient instead
// of clamping to deep navy. Keep in lock-step with the 3 sites.
const SPL_MIN_DB = 30;
const SPL_MAX_DB = 110;

// Build a 256-entry palette LUT as a 256×1 RGBA DataTexture for the
// given metric. The shader samples this with the normalised SPL/STI
// value as a U coordinate; nearest-neighbour or linear filter both
// work because adjacent palette entries already differ by ~0.2-1%.
//
// Cached per-metric to avoid rebuilding on every heatmap refresh
// (the palette is a constant function of `metric`).
const _paletteCache = new Map();   // metric → DataTexture
export function buildPaletteTexture(metric) {
  const cached = _paletteCache.get(metric);
  if (cached) return cached;
  const data = new Uint8Array(256 * 4);
  const colorFn = metric === 'sti' ? stiColorRGB : splColorRGB;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;                          // 0..1
    const value = metric === 'sti'
      ? t                                       // STI already in [0,1]
      : SPL_MIN_DB + t * (SPL_MAX_DB - SPL_MIN_DB);
    const [r, g, b] = colorFn(value);
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _paletteCache.set(metric, tex);
  return tex;
}

// Build a scalar-field DataTexture from the SPL grid. RGBA8 layout:
//   R = normalised value (0..255 → 0..1)
//   GBA = unused (set equal to R for shader debugging convenience)
//   A on the SAMPLER never used — caller adds the `validMask` uniform
//     for sentinel handling instead, because GPU bilinear of A would
//     create translucent halos around -Infinity cells.
//
// To carry the "no data" sentinel without polluting the bilinear blend,
// we use a SEPARATE 1-bit valid-mask texture (validTex) that's sampled
// nearest-neighbour in the fragment shader.
export function buildScalarTexture(splInfo) {
  const { grid, cellsX, cellsY, metric } = splInfo;
  const useSTI = metric === 'sti';
  // Wide value-domain for SPL → normalise to [0, 1].
  const normalise = useSTI
    ? (v) => Math.max(0, Math.min(1, v))
    : (v) => Math.max(0, Math.min(1, (v - SPL_MIN_DB) / (SPL_MAX_DB - SPL_MIN_DB)));

  const data = new Uint8Array(cellsX * cellsY * 4);
  const mask = new Uint8Array(cellsX * cellsY);
  // Row-flip when writing: the consumer UV math in scene.js was authored
  // against CanvasTexture (which defaults flipY=true so the canvas's top
  // row lands at UV.v=1). DataTexture IGNORES the flipY hint per
  // Three.js docs — without flipping here, south physics cells (grid
  // row j=0) land at UV.v=0 (bottom) but the UV mapping
  // `uv.v = 1 - (sy - minY) / d` looks them up at UV.v=1 (top), so
  // SOUTH data is painted at the NORTH screen position and vice versa.
  // The bug was user-visible in the surau preset 2026-05-18 — south
  // podium (with 3 arcade speakers, ~99 dB at 1 kHz) read as cool blue
  // while the north qibla podium (no speakers, ~74 dB) read as warm
  // yellow. Pre-emptively flipping the data row order here keeps the
  // shader path output identical to the legacy CanvasTexture path
  // without needing to branch the UV code in scene.js.
  for (let j = 0; j < cellsY; j++) {
    const jSrc = cellsY - 1 - j;            // mirror to match flipY=true
    for (let i = 0; i < cellsX; i++) {
      const v = grid[jSrc][i];
      const idx = j * cellsX + i;
      if (!Number.isFinite(v)) {
        // Sentinel — write 0 to scalar (so bilinear blend doesn't pull
        // neighbours toward extreme values) and 0 to mask.
        data[idx * 4 + 0] = 0;
        data[idx * 4 + 1] = 0;
        data[idx * 4 + 2] = 0;
        data[idx * 4 + 3] = 255;
        mask[idx] = 0;
      } else {
        const byteVal = Math.round(normalise(v) * 255);
        data[idx * 4 + 0] = byteVal;
        data[idx * 4 + 1] = byteVal;
        data[idx * 4 + 2] = byteVal;
        data[idx * 4 + 3] = 255;
        mask[idx] = 255;
      }
    }
  }
  const scalarTex = new THREE.DataTexture(data, cellsX, cellsY, THREE.RGBAFormat, THREE.UnsignedByteType);
  scalarTex.magFilter = THREE.LinearFilter;        // GPU bilinear on scalar
  scalarTex.minFilter = THREE.LinearFilter;
  scalarTex.wrapS = THREE.ClampToEdgeWrapping;
  scalarTex.wrapT = THREE.ClampToEdgeWrapping;
  scalarTex.generateMipmaps = false;
  scalarTex.needsUpdate = true;

  const maskTex = new THREE.DataTexture(mask, cellsX, cellsY, THREE.RedFormat, THREE.UnsignedByteType);
  maskTex.magFilter = THREE.NearestFilter;         // sentinel must NOT blend
  maskTex.minFilter = THREE.NearestFilter;
  maskTex.wrapS = THREE.ClampToEdgeWrapping;
  maskTex.wrapT = THREE.ClampToEdgeWrapping;
  maskTex.generateMipmaps = false;
  maskTex.needsUpdate = true;

  return { scalarTex, maskTex };
}

// Vertex shader — pass UV through; standard rendering pipeline.
const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fragment shader — sample bilinear-interpolated scalar, nearest-neighbour
// validity mask, then look up palette. Cells with mask=0 discard.
const FRAG = /* glsl */`
  uniform sampler2D scalarTex;
  uniform sampler2D maskTex;
  uniform sampler2D paletteTex;
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float valid = texture2D(maskTex, vUv).r;
    if (valid < 0.5) discard;
    float t = texture2D(scalarTex, vUv).r;
    vec3 color = texture2D(paletteTex, vec2(t, 0.5)).rgb;
    gl_FragColor = vec4(color, opacity);
  }
`;

// Build a ShaderMaterial that renders the scalar-field heatmap with
// fragment-shader palette lookup. Returns { material, scalarTex, maskTex }.
// Caller is responsible for disposing all three on rebuild.
export function buildHeatmapShaderMaterial(splInfo, { opacity = 0.95 } = {}) {
  const { scalarTex, maskTex } = buildScalarTexture(splInfo);
  const paletteTex = buildPaletteTexture(splInfo.metric ?? 'spl');
  const material = new THREE.ShaderMaterial({
    uniforms: {
      scalarTex:  { value: scalarTex },
      maskTex:    { value: maskTex },
      paletteTex: { value: paletteTex },
      opacity:    { value: opacity },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return { material, scalarTex, maskTex };
}
