// FurnitureLAB glyphs — isometric-ink illustrations of catalogue
// objects, drawn at the time the card renders (not pre-baked PNGs)
// so they scale cleanly across the catalogue card, the 2D viewport
// top-down render, and the print plan SVG.
//
// Visual language (Maya, ux-designer, 2026-05-26):
//   - 30° axonometric (true iso projection — 30°/30° on both ground axes)
//   - 1.25 pt stroke, ink #1A1A1A on paper #FAFAF7
//   - ONE accent stroke (--print-accent terracotta) reserved for the
//     'active surface' of the object, i.e. where the acoustics happens.
//     For a theater seat that is the upholstered cushion + back face.
//   - No drop shadow, no fill (except the paper-tinted face shades that
//     give the iso boxes their volume).
//   - Strokes use stroke-linecap="round" + stroke-linejoin="round" so
//     small thumbnail renders stay visually clean.
//
// Each glyph builder returns an SVG string with a fixed viewBox. The
// CARD renders it scaled to the card thumb (e.g. 240×180). The 2D
// VIEWPORT renders the same SVG scaled to the object's footprint in
// state coords — same asset, three surfaces, parity-by-construction
// (Sam's cross-surface convention rule).

const INK    = '#1A1A1A';
const ACCENT = '#9A3F2A';  // the project's print-accent terracotta
const PAPER_SHADE_LIGHT = '#F2EDE3';
const PAPER_SHADE_MID   = '#E5DDCB';
const PAPER_SHADE_DARK  = '#D6CBB3';

// --- Iso projection helpers ------------------------------------------
// World axes: +x to viewer's right-front, +y away into the page,
// +z up. Project to 2D using true isometric (30°/30° on both ground
// axes). The screen-y axis points DOWN in SVG, so the projection
// subtracts on the up direction.
//
//   px = cx + (x - y) * scale * cos(30°)
//   py = cy - z * scale - (x + y) * scale * sin(30°)
const COS30 = 0.86602540378443864676;
const SIN30 = 0.5;

function iso(x, y, z, scale, cx, cy) {
  const px = cx + (x - y) * scale * COS30;
  const py = cy - z * scale - (x + y) * scale * SIN30;
  return [px, py];
}

// Build the three visible faces of an axis-aligned box (top, front,
// right) as separate SVG path strings. Caller chooses fills / strokes /
// accent on each face independently. Faces are emitted in z-order
// (back-to-front in screen depth):
//   right face is drawn first (deepest behind), then front, then top.
// Returns { top, front, right, edgesOpenFront, edgesOpenBack }.
//
// `edgesOpenFront` is the silhouette outline that joins the visible
// corners — useful for accent strokes that highlight only the
// silhouette of the cushion (not its hidden bottom edge).
function boxFaces(x1, y1, z1, x2, y2, z2, scale, cx, cy) {
  const p = (x, y, z) => {
    const [px, py] = iso(x, y, z, scale, cx, cy);
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  };
  return {
    top:   `M${p(x1, y1, z2)} L${p(x2, y1, z2)} L${p(x2, y2, z2)} L${p(x1, y2, z2)} Z`,
    front: `M${p(x1, y1, z1)} L${p(x2, y1, z1)} L${p(x2, y1, z2)} L${p(x1, y1, z2)} Z`,
    right: `M${p(x2, y1, z1)} L${p(x2, y2, z1)} L${p(x2, y2, z2)} L${p(x2, y1, z2)} Z`,
  };
}

// --- Theater seat (upholstered, occupied) ----------------------------
// Dimensions taken from the catalogue footprint (0.55 m wide, 0.60 m
// deep, 1.20 m tall). Composed of four boxes:
//   1. Front legs band   (a single dark base slab)
//   2. Seat cushion      (the ACCENT surface — terracotta top edge)
//   3. Two armrests
//   4. Seat back
//
// viewBox is sized to comfortably contain the iso extents at scale=70:
//   x extent: ±0.55 × 0.866 × 70 ≈ ±33 px  → 80 px wide with margins
//   y extent: 1.20 × 70 + (0.55+0.60)×0.5×70 ≈ 124 px → 150 px tall
// Final viewBox 0 0 110 140 with origin shifted to (55, 110) leaves
// equal optical margins.
function glyph_theaterSeat({ scale = 70, cx = 55, cy = 110, paper = false } = {}) {
  const W = 0.55, D = 0.60, H_SEAT = 0.42, H_CUSH = 0.50, H_ARM = 0.66, H_BACK = 1.18;

  // Front leg base — a thin slab spanning the footprint, z [0, 0.10]
  const base    = boxFaces(0.02, 0.02, 0.00, W - 0.02, D - 0.02, 0.10, scale, cx, cy);
  // Seat cushion — the accent surface, z [H_SEAT, H_CUSH]
  const cushion = boxFaces(0.04, 0.04, H_SEAT, W - 0.04, D - 0.06, H_CUSH, scale, cx, cy);
  // Left armrest — narrow vertical column on +x side (left in iso view due to mirroring)
  const armL    = boxFaces(0.00, 0.06, H_SEAT, 0.08, D - 0.08, H_ARM, scale, cx, cy);
  const armR    = boxFaces(W - 0.08, 0.06, H_SEAT, W, D - 0.08, H_ARM, scale, cx, cy);
  // Seat back — slim slab against the back edge (y near D)
  const back    = boxFaces(0.02, D - 0.10, H_CUSH, W - 0.02, D - 0.02, H_BACK, scale, cx, cy);

  const STROKE = paper ? 0.9 : 1.25;
  const fills = {
    base:    `fill="${PAPER_SHADE_DARK}"`,
    cushion: `fill="${PAPER_SHADE_LIGHT}"`,
    arm:     `fill="${PAPER_SHADE_MID}"`,
    back:    `fill="${PAPER_SHADE_MID}"`,
  };

  // Draw order: back-to-front in screen depth.
  //   base → back (deepest) → arms → cushion (foreground/active)
  return `
    <g class="fl-glyph fl-glyph-theater-seat" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <!-- base slab — front + right + top -->
      <path d="${base.right}"   ${fills.base} />
      <path d="${base.front}"   ${fills.base} />
      <path d="${base.top}"     ${fills.base} />

      <!-- seat back — drawn before arms so arms occlude correctly -->
      <path d="${back.right}"   ${fills.back} />
      <path d="${back.front}"   ${fills.back} />
      <path d="${back.top}"     ${fills.back} />

      <!-- armrests -->
      <path d="${armL.right}"   ${fills.arm} />
      <path d="${armL.front}"   ${fills.arm} />
      <path d="${armL.top}"     ${fills.arm} />
      <path d="${armR.right}"   ${fills.arm} />
      <path d="${armR.front}"   ${fills.arm} />
      <path d="${armR.top}"     ${fills.arm} />

      <!-- cushion — accent stroke on the TOP face only (the active surface) -->
      <path d="${cushion.right}" ${fills.cushion} />
      <path d="${cushion.front}" ${fills.cushion} />
      <path d="${cushion.top}"   ${fills.cushion} stroke="${ACCENT}" stroke-width="${(STROKE * 1.3).toFixed(2)}" />
    </g>`;
}

// --- Public registry -------------------------------------------------
// Maps catalogueId → glyph builder. New catalogue entries register
// their glyph here. When a catalogue id has no registered glyph we
// fall back to a labelled wireframe box (the procedural primitive
// builder below).
const GLYPHS = new Map([
  ['theater-seat-upholstered-occupied', glyph_theaterSeat],
]);

/**
 * Build a glyph for the catalogue item. Returns an SVG `<g>` group
 * string suitable for embedding inside any SVG. The viewBox to use
 * around it is provided by glyphViewBox(item).
 *
 * @param {object} item   catalogue row
 * @param {object} opts   override scale / origin / paper-mode
 */
export function buildGlyph(item, opts = {}) {
  const builder = GLYPHS.get(item?.id);
  if (typeof builder === 'function') return builder(opts);
  // Fallback — procedural wireframe box keyed off the footprint.
  return glyph_fallbackBox(item, opts);
}

/**
 * Default viewBox for the glyph. All builders agree on (0 0 110 140)
 * so the catalogue card layout doesn't have to special-case sizes.
 */
export function glyphViewBox() {
  return '0 0 110 140';
}

// Generic wireframe-box fallback for catalogue rows that don't yet
// have a hand-drawn glyph. Reads the footprint and draws an iso box
// at the same scale as the dedicated glyphs.
function glyph_fallbackBox(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = Math.max(0.1, item?.footprint?.width_m  ?? 0.5);
  const D = Math.max(0.1, item?.footprint?.depth_m  ?? 0.5);
  const H = Math.max(0.1, item?.footprint?.height_m ?? 0.8);
  const f = boxFaces(0, 0, 0, W, D, H, scale, cx, cy);
  return `
    <g class="fl-glyph fl-glyph-fallback" stroke="${INK}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${f.right}" fill="${PAPER_SHADE_MID}" />
      <path d="${f.front}" fill="${PAPER_SHADE_MID}" />
      <path d="${f.top}"   fill="${PAPER_SHADE_LIGHT}" />
    </g>`;
}
