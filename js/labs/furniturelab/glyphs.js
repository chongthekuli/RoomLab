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
  const LEG_W = 0.08, LEG_INSET = 0.07;
  const STRETCHER_TH = 0.04;
  const STRETCHER_Z  = H_SEAT * 0.30;

  // Four corner legs + low front/back stretcher bars from floor (z=0)
  // up to the cushion bottom (H_SEAT). v=675 — thickened from 0.05 to
  // 0.08 m so the legs survive the white-on-pale visual collision the
  // user reported at v=674 ("seat and footer detached"); stretchers
  // make the base read as a connected chair frame from any angle.
  const legBoxes = [
    // back-left, back-right, front-left, front-right (draw order:
    // back pair first for proper z-occlusion)
    [LEG_INSET,             D - LEG_INSET - LEG_W],
    [W - LEG_INSET - LEG_W, D - LEG_INSET - LEG_W],
    [LEG_INSET,             LEG_INSET],
    [W - LEG_INSET - LEG_W, LEG_INSET],
  ].map(([x0, y0]) => boxFaces(x0, y0, 0, x0 + LEG_W, y0 + LEG_W, H_SEAT, scale, cx, cy));

  // Stretchers — horizontal bars between front pair and back pair.
  // Drawn at a low z so they sit clearly below the cushion.
  const stretcherFront = boxFaces(
    LEG_INSET + LEG_W, LEG_INSET, STRETCHER_Z - STRETCHER_TH / 2,
    W - LEG_INSET - LEG_W, LEG_INSET + LEG_W, STRETCHER_Z + STRETCHER_TH / 2,
    scale, cx, cy,
  );
  const stretcherBack = boxFaces(
    LEG_INSET + LEG_W, D - LEG_INSET - LEG_W, STRETCHER_Z - STRETCHER_TH / 2,
    W - LEG_INSET - LEG_W, D - LEG_INSET, STRETCHER_Z + STRETCHER_TH / 2,
    scale, cx, cy,
  );

  // Seat cushion — the accent surface, z [H_SEAT, H_CUSH]
  const cushion = boxFaces(0.04, 0.04, H_SEAT, W - 0.04, D - 0.06, H_CUSH, scale, cx, cy);
  // Left armrest — narrow vertical column on +x side (left in iso view due to mirroring)
  const armL    = boxFaces(0.00, 0.06, H_SEAT, 0.08, D - 0.08, H_ARM, scale, cx, cy);
  const armR    = boxFaces(W - 0.08, 0.06, H_SEAT, W, D - 0.08, H_ARM, scale, cx, cy);
  // Seat back — slim slab against the back edge (y near D)
  const back    = boxFaces(0.02, D - 0.10, H_CUSH, W - 0.02, D - 0.02, H_BACK, scale, cx, cy);

  const STROKE = paper ? 0.9 : 1.25;
  const fills = {
    leg:     `fill="${PAPER_SHADE_DARK}"`,
    cushion: `fill="${PAPER_SHADE_LIGHT}"`,
    arm:     `fill="${PAPER_SHADE_MID}"`,
    back:    `fill="${PAPER_SHADE_MID}"`,
  };

  // Draw order: back-to-front in screen depth.
  //   back legs → back panel → arms → front legs → cushion (foreground/active)
  // Render front-legs AFTER the cushion would over-occlude them
  // (legs are slim and visually anchor the chair) — but the cushion
  // sits ABOVE the leg tops so cushion-after-front-legs is correct.
  const legPaths = (leg) => `
    <path d="${leg.right}" ${fills.leg} />
    <path d="${leg.front}" ${fills.leg} />
    <path d="${leg.top}"   ${fills.leg} />`;

  return `
    <g class="fl-glyph fl-glyph-theater-seat" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <!-- back legs -->
      ${legPaths(legBoxes[0])}
      ${legPaths(legBoxes[1])}

      <!-- back stretcher (connects back-left and back-right legs) -->
      <path d="${stretcherBack.right}" ${fills.leg} />
      <path d="${stretcherBack.front}" ${fills.leg} />
      <path d="${stretcherBack.top}"   ${fills.leg} />

      <!-- seat back — drawn before arms so arms occlude correctly -->
      <path d="${back.right}"   ${fills.back} />
      <path d="${back.front}"   ${fills.back} />
      <path d="${back.top}"     ${fills.back} />

      <!-- front legs -->
      ${legPaths(legBoxes[2])}
      ${legPaths(legBoxes[3])}

      <!-- front stretcher (connects front-left and front-right legs) -->
      <path d="${stretcherFront.right}" ${fills.leg} />
      <path d="${stretcherFront.front}" ${fills.leg} />
      <path d="${stretcherFront.top}"   ${fills.leg} />

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

// --- Family-aware iso builders ---------------------------------------
// Each family produces an iso illustration sized from the catalogue
// footprint. Families match the 3D builders in scene.js so the card
// preview matches the in-scene mesh silhouette.

// Slab-on-legs (tables, lecterns). Top slab gets the accent stroke
// (top surface is what the room "sees").
function glyph_slabOnLegs(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = Math.max(0.1, item?.footprint?.width_m  ?? 1.0);
  const D = Math.max(0.1, item?.footprint?.depth_m  ?? 0.5);
  const H = Math.max(0.1, item?.footprint?.height_m ?? 0.74);
  const slabThk = Math.min(0.04, H * 0.08);
  const slabHi  = H;
  const slabLo  = H - slabThk;
  const slab    = boxFaces(0, 0, slabLo, W, D, slabHi, scale, cx, cy);
  // Four legs as thin vertical boxes (inset 0.05 m from corners).
  const inset = 0.05;
  const legR  = 0.03;
  const leg = (x, y) => boxFaces(x - legR, y - legR, 0, x + legR, y + legR, slabLo, scale, cx, cy);
  const legs = [leg(inset, inset), leg(W - inset, inset), leg(inset, D - inset), leg(W - inset, D - inset)];
  return `
    <g class="fl-glyph fl-glyph-slab" stroke="${INK}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none">
      ${legs.map(l => `
        <path d="${l.right}" fill="${PAPER_SHADE_DARK}" />
        <path d="${l.front}" fill="${PAPER_SHADE_DARK}" />
        <path d="${l.top}"   fill="${PAPER_SHADE_DARK}" />
      `).join('')}
      <path d="${slab.right}" fill="${PAPER_SHADE_MID}" />
      <path d="${slab.front}" fill="${PAPER_SHADE_MID}" />
      <path d="${slab.top}"   fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
    </g>`;
}

// Vertical box (bookshelves, server racks). Front face accent +
// horizontal dividers that read as shelves / U-rows.
function glyph_verticalBox(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = Math.max(0.1, item?.footprint?.width_m  ?? 0.6);
  const D = Math.max(0.1, item?.footprint?.depth_m  ?? 0.3);
  const H = Math.max(0.1, item?.footprint?.height_m ?? 2.0);
  const body = boxFaces(0, 0, 0, W, D, H, scale, cx, cy);
  // 4 divider lines on the front face. Project each as two iso points.
  const proj = (x, y, z) => {
    const [px, py] = iso(x, y, z, scale, cx, cy);
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  };
  const dividers = [];
  for (let i = 1; i <= 4; i++) {
    const z = (i / 5) * H;
    dividers.push(`M${proj(0.02, 0, z)} L${proj(W - 0.02, 0, z)}`);
  }
  return `
    <g class="fl-glyph fl-glyph-vbox" stroke="${INK}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${body.right}" fill="${PAPER_SHADE_DARK}" />
      <path d="${body.front}" fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
      <path d="${body.top}"   fill="${PAPER_SHADE_MID}" />
      ${dividers.map(d => `<path d="${d}" stroke="${ACCENT}" stroke-width="0.9" />`).join('')}
    </g>`;
}

// Flat pad (audience block, prayer mat, rug). Low slab hugging the
// floor — small height in iso reads as "carpet, not furniture".
function glyph_flatPad(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = Math.max(0.1, item?.footprint?.width_m ?? 1.0);
  const D = Math.max(0.1, item?.footprint?.depth_m ?? 1.0);
  const H = Math.max(0.02, Math.min(0.06, item?.footprint?.height_m ?? 0.03));
  const pad = boxFaces(0, 0, 0, W, D, H, scale, cx, cy);
  return `
    <g class="fl-glyph fl-glyph-pad" stroke="${INK}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${pad.right}" fill="${PAPER_SHADE_MID}" />
      <path d="${pad.front}" fill="${PAPER_SHADE_MID}" />
      <path d="${pad.top}"   fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
    </g>`;
}

// Seat family is parameterised by the existing detailed builder above;
// wrap it so the dispatcher can call all families the same way.
function glyph_seat(item, opts = {}) {
  return glyph_theaterSeat(opts);
}

const FAMILY_GLYPHS = {
  'seat': glyph_seat,
  'slab-on-legs': glyph_slabOnLegs,
  'vertical-box': glyph_verticalBox,
  'flat-pad': glyph_flatPad,
};

// --- Public registry -------------------------------------------------
// Per-id overrides (use when an item deserves a hand-drawn glyph that
// trumps its family default). Empty for now; the family dispatch below
// covers every Phase-1A row.
const GLYPHS = new Map([]);

/**
 * Build a glyph for the catalogue item. Returns an SVG `<g>` group
 * string suitable for embedding inside any SVG. The viewBox to use
 * around it is provided by glyphViewBox(item).
 *
 * @param {object} item   catalogue row
 * @param {object} opts   override scale / origin / paper-mode
 */
export function buildGlyph(item, opts = {}) {
  // 1. Per-id override has highest priority (hand-drawn glyphs).
  const byId = GLYPHS.get(item?.id);
  if (typeof byId === 'function') return byId(item, opts);
  // 2. Family dispatch — every catalogue row carries visual.family.
  const family = item?.visual?.family;
  const byFamily = FAMILY_GLYPHS[family];
  if (typeof byFamily === 'function') return byFamily(item, opts);
  // 3. Last resort — wireframe box keyed off the footprint.
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
