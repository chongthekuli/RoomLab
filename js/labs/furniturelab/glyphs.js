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

// --- Shared iso primitives -------------------------------------------
// Project a single point to an SVG "x,y" coordinate pair string.
function isoStr(x, y, z, scale, cx, cy) {
  const [px, py] = iso(x, y, z, scale, cx, cy);
  return `${px.toFixed(2)},${py.toFixed(2)}`;
}

// Emit the three visible faces of a box as SVG <path>s, back-to-front,
// with caller-chosen face fills + an optional accent stroke on the top.
function boxPaths(b, { topFill = PAPER_SHADE_LIGHT, frontFill = PAPER_SHADE_MID,
                       rightFill = PAPER_SHADE_DARK, accentTop = false,
                       stroke = 1.25 } = {}) {
  const accent = accentTop
    ? ` stroke="${ACCENT}" stroke-width="${(stroke * 1.3).toFixed(2)}"`
    : '';
  return `
    <path d="${b.right}" fill="${rightFill}" />
    <path d="${b.front}" fill="${frontFill}" />
    <path d="${b.top}"   fill="${topFill}"${accent} />`;
}

// --- Seated-occupant silhouette --------------------------------------
// A simple iso human reading as "someone is sitting here". Built from a
// few stacked iso boxes (thighs flat, shins down, torso up, head cube)
// so it shares the exact projection of the chair it sits in. Ink stroke
// only — the terracotta accent stays reserved for the acoustic surface.
//
//   ox, oy  = footprint origin (front-left corner) of the seat region
//   seatZ   = cushion-top height the occupant sits on
// The occupant faces +y-toward-viewer-front (toward smaller y), matching
// the chairs (which face the room front at small y).
function occupantFigure(ox, oy, seatZ, scale, cx, cy, { stroke = 1.1 } = {}) {
  const SH = `stroke-width="${stroke.toFixed(2)}"`;
  // Centre the body on the seat in x; sit it toward the back in y.
  const bx = ox;                 // body centre x
  const thighFrontY = oy - 0.20; // knees forward (toward viewer)
  const thighBackY  = oy + 0.06;
  const torsoY      = oy + 0.10;

  // Thighs — a short horizontal box on the cushion.
  const thigh = boxFaces(bx - 0.14, thighFrontY, seatZ, bx + 0.14, thighBackY, seatZ + 0.12, scale, cx, cy);
  // Shins — drop from the knee toward the floor at the front.
  const shin  = boxFaces(bx - 0.12, thighFrontY - 0.02, seatZ - 0.40, bx + 0.12, thighFrontY + 0.12, seatZ, scale, cx, cy);
  // Torso — upright box rising from the hips.
  const torso = boxFaces(bx - 0.15, torsoY - 0.02, seatZ + 0.10, bx + 0.15, torsoY + 0.18, seatZ + 0.55, scale, cx, cy);
  // Head — small cube atop the torso.
  const head  = boxFaces(bx - 0.085, torsoY + 0.01, seatZ + 0.55, bx + 0.085, torsoY + 0.18, seatZ + 0.72, scale, cx, cy);

  const fillSkin = PAPER_SHADE_LIGHT, fillBody = PAPER_SHADE_MID, fillDark = PAPER_SHADE_DARK;
  return `
    <g class="fl-occupant" stroke="${INK}" ${SH} stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${shin.right}"  fill="${fillDark}" />
      <path d="${shin.front}"  fill="${fillBody}" />
      <path d="${shin.top}"    fill="${fillBody}" />
      <path d="${thigh.right}" fill="${fillDark}" />
      <path d="${thigh.front}" fill="${fillBody}" />
      <path d="${thigh.top}"   fill="${fillBody}" />
      <path d="${torso.right}" fill="${fillDark}" />
      <path d="${torso.front}" fill="${fillBody}" />
      <path d="${torso.top}"   fill="${fillBody}" />
      <path d="${head.right}"  fill="${fillDark}" />
      <path d="${head.front}"  fill="${fillSkin}" />
      <path d="${head.top}"    fill="${fillSkin}" />
    </g>`;
}

// --- Theater seat (cinema fold-up) -----------------------------------
// Real-fidelity match to scene.js _build_theaterSeat: single black sled-
// foot pedestal (NOT four legs), tall contoured upholstered back, sponge
// cushion (accent top), chunky armrests with a cup-holder dish. The empty
// vs occupied switch only adds the seated-occupant figure.
function glyph_theaterSeatGlyph(occupied, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 0.55, D = 0.60;
  const PED_TOP = 0.40, CUSH_LO = 0.42, CUSH_HI = 0.50;
  const ARM_HI = 0.66, BACK_HI = 1.18;
  const STROKE = 1.25;

  // Single central sled pedestal: a flat foot bar on the floor + a
  // narrow riser column up to the seat. Black plastic (dark fill).
  const footBar = boxFaces(W * 0.30, 0.06, 0.0, W * 0.70, D - 0.06, 0.05, scale, cx, cy);
  const riser   = boxFaces(W * 0.40, D * 0.30, 0.05, W * 0.60, D * 0.62, PED_TOP, scale, cx, cy);

  // Sponge cushion — the accent surface.
  const cushion = boxFaces(0.05, 0.06, CUSH_LO, W - 0.05, D - 0.10, CUSH_HI, scale, cx, cy);

  // Tall contoured back — slim slab, leans against the back edge, runs up
  // nearly to full height. Reads as the cinema high-back.
  const back = boxFaces(0.04, D - 0.12, CUSH_LO, W - 0.04, D - 0.04, BACK_HI, scale, cx, cy);

  // Two chunky armrests with a cup-holder dish recess on the top face.
  const armL = boxFaces(0.00, 0.10, CUSH_LO, 0.10, D - 0.12, ARM_HI, scale, cx, cy);
  const armR = boxFaces(W - 0.10, 0.10, CUSH_LO, W, D - 0.12, ARM_HI, scale, cx, cy);
  // Cup-holder dish: small ellipse on each armrest top, ink stroke.
  const cupL = isoStr(0.05, (0.10 + D - 0.12) / 2, ARM_HI, scale, cx, cy);
  const cupR = isoStr(W - 0.05, (0.10 + D - 0.12) / 2, ARM_HI, scale, cx, cy);

  const DARK = { topFill: PAPER_SHADE_DARK, frontFill: PAPER_SHADE_DARK, rightFill: PAPER_SHADE_DARK };
  const ARM  = { topFill: PAPER_SHADE_MID,  frontFill: PAPER_SHADE_MID,  rightFill: PAPER_SHADE_DARK };
  const BACK = { topFill: PAPER_SHADE_MID,  frontFill: PAPER_SHADE_LIGHT, rightFill: PAPER_SHADE_MID };

  // Pedestal fills are the black sled (very dark) — emulate with dark shade.
  const occ = occupied ? occupantFigure(W / 2, D * 0.52, CUSH_HI, scale, cx, cy) : '';

  return `
    <g class="fl-glyph fl-glyph-theater-seat" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <!-- sled pedestal -->
      ${boxPaths(footBar, DARK)}
      ${boxPaths(riser, DARK)}
      <!-- tall contoured back -->
      ${boxPaths(back, BACK)}
      <!-- cushion (accent active surface) -->
      ${boxPaths(cushion, { topFill: PAPER_SHADE_LIGHT, frontFill: PAPER_SHADE_LIGHT, rightFill: PAPER_SHADE_MID, accentTop: true, stroke: STROKE })}
      ${occ}
      <!-- armrests with cup-holder dishes (drawn last; foreground) -->
      ${boxPaths(armL, ARM)}
      ${boxPaths(armR, ARM)}
      <ellipse cx="${cupL.split(',')[0]}" cy="${cupL.split(',')[1]}" rx="${(scale * 0.045).toFixed(2)}" ry="${(scale * 0.026).toFixed(2)}" fill="none" stroke="${INK}" stroke-width="0.9" />
      <ellipse cx="${cupR.split(',')[0]}" cy="${cupR.split(',')[1]}" rx="${(scale * 0.045).toFixed(2)}" ry="${(scale * 0.026).toFixed(2)}" fill="none" stroke="${INK}" stroke-width="0.9" />
    </g>`;
}

// --- Office task chair -----------------------------------------------
// 5-star caster base + gas-lift column + swivel seat (accent top) + low
// back + optional arms. Visually distinct from the cinema seat: no sled,
// no tall back, a star base instead of a pedestal bar.
function glyph_officeChairGlyph(occupied, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 0.60, D = 0.60;
  const SEAT_LO = 0.44, SEAT_HI = 0.50, BACK_HI = 1.02, ARM_HI = 0.66;
  const STROKE = 1.25;
  const bx = W / 2, by = D / 2;

  // 5-star base: five spokes radiating on the floor from the column foot.
  // Drawn as iso lines from the centre to caster ends, each with a small
  // caster wheel ellipse. Five angles spread around the circle.
  const baseZ = 0.0;
  const spokeR = 0.26;
  const spokes = [];
  for (let i = 0; i < 5; i++) {
    const ang = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    const ex = bx + Math.cos(ang) * spokeR;
    const ey = by + Math.sin(ang) * spokeR;
    const c0 = isoStr(bx, by, baseZ, scale, cx, cy);
    const c1 = isoStr(ex, ey, baseZ, scale, cx, cy);
    const cast = isoStr(ex, ey, baseZ, scale, cx, cy).split(',');
    spokes.push(`<path d="M${c0} L${c1}" stroke="${INK}" stroke-width="${(STROKE * 1.1).toFixed(2)}" />
      <ellipse cx="${cast[0]}" cy="${cast[1]}" rx="${(scale * 0.03).toFixed(2)}" ry="${(scale * 0.018).toFixed(2)}" fill="${PAPER_SHADE_DARK}" stroke="${INK}" stroke-width="0.8" />`);
  }
  // Gas-lift column — slim vertical box from base to seat bottom.
  const column = boxFaces(bx - 0.04, by - 0.04, baseZ, bx + 0.04, by + 0.04, SEAT_LO, scale, cx, cy);
  // Swivel seat pad — accent top, square-ish, slightly rounded read.
  const seat = boxFaces(0.06, 0.08, SEAT_LO, W - 0.06, D - 0.06, SEAT_HI, scale, cx, cy);
  // Low contoured back — shorter than the cinema back, set at the rear.
  const back = boxFaces(0.10, D - 0.12, SEAT_HI + 0.10, W - 0.10, D - 0.05, BACK_HI, scale, cx, cy);
  // Arms — short, optional but office chairs read better with them.
  const armL = boxFaces(0.00, 0.16, SEAT_HI, 0.07, D - 0.16, ARM_HI, scale, cx, cy);
  const armR = boxFaces(W - 0.07, 0.16, SEAT_HI, W, D - 0.16, ARM_HI, scale, cx, cy);

  const DARK = { topFill: PAPER_SHADE_DARK, frontFill: PAPER_SHADE_DARK, rightFill: PAPER_SHADE_DARK };
  const ARM  = { topFill: PAPER_SHADE_MID,  frontFill: PAPER_SHADE_MID,  rightFill: PAPER_SHADE_DARK };
  const BACK = { topFill: PAPER_SHADE_MID,  frontFill: PAPER_SHADE_LIGHT, rightFill: PAPER_SHADE_MID };
  const occ = occupied ? occupantFigure(bx, D * 0.50, SEAT_HI, scale, cx, cy) : '';

  return `
    <g class="fl-glyph fl-glyph-office-chair" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <!-- 5-star caster base -->
      ${spokes.join('')}
      <!-- gas-lift column -->
      ${boxPaths(column, DARK)}
      <!-- low back -->
      ${boxPaths(back, BACK)}
      <!-- swivel seat (accent active surface) -->
      ${boxPaths(seat, { topFill: PAPER_SHADE_LIGHT, frontFill: PAPER_SHADE_LIGHT, rightFill: PAPER_SHADE_MID, accentTop: true, stroke: STROKE })}
      ${occ}
      <!-- arms -->
      ${boxPaths(armL, ARM)}
      ${boxPaths(armR, ARM)}
    </g>`;
}

// --- Audience block (occupied, per m²) -------------------------------
// A 1 m² floor tile carrying a small grid of seated-occupant silhouettes
// reading as "occupied audience density". Respects the ~1.2 m block
// height (occupants stand ~1.2 m seated-eye), NOT a flat mat.
function glyph_audienceBlock(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 1.0, D = 1.0, SEAT_Z = 0.45;
  const STROKE = 1.25;
  // Floor tile (accent top = the acoustically-active occupied area).
  const tile = boxFaces(0, 0, 0, W, D, 0.04, scale, cx, cy);
  // 2×2 cluster of occupants on the tile, drawn back-to-front for
  // correct z-occlusion (larger y first = furthest back).
  const cols = [0.30, 0.70];
  const rows = [0.66, 0.30];  // back row first
  const people = [];
  for (const ry of rows) {
    for (const cxn of cols) {
      people.push(occupantFigure(cxn, ry, SEAT_Z, scale, cx, cy, { stroke: 0.95 }));
    }
  }
  return `
    <g class="fl-glyph fl-glyph-audience-block" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${tile.right}" fill="${PAPER_SHADE_MID}" />
      <path d="${tile.front}" fill="${PAPER_SHADE_MID}" />
      <path d="${tile.top}"   fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
      ${people.join('')}
    </g>`;
}

// --- Lectern (wood, free-standing) -----------------------------------
// An ANGLED reading top on a single tapered column/podium — NOT a table.
function glyph_lectern(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 0.60, D = 0.45, H = 1.15;
  const STROKE = 1.25;
  // Tapered podium body — wider at base, narrower at top. Approximate the
  // taper with a single box (front face wood) plus a base plinth.
  const plinth = boxFaces(0.04, 0.02, 0.0, W - 0.04, D - 0.02, 0.06, scale, cx, cy);
  const column = boxFaces(0.12, 0.08, 0.06, W - 0.12, D - 0.08, H - 0.16, scale, cx, cy);

  // Angled reading top: a slab tilted up toward the back. Build it as a
  // quad in iso, with the front edge lower than the back edge.
  const topZf = H - 0.14;       // front edge height
  const topZb = H;              // back edge height (raised → reading slope)
  const x0 = 0.02, x1 = W - 0.02, yF = 0.0, yB = D;
  const TL = isoStr(x0, yF, topZf, scale, cx, cy);
  const TR = isoStr(x1, yF, topZf, scale, cx, cy);
  const BR = isoStr(x1, yB, topZb, scale, cx, cy);
  const BL = isoStr(x0, yB, topZb, scale, cx, cy);
  // A small lip on the front edge of the reading top so it reads as a
  // lectern (stops the speaker's notes sliding off).
  const lipF = isoStr(x0, yF, topZf, scale, cx, cy);
  const lipF2 = isoStr(x1, yF, topZf, scale, cx, cy);
  const lipBz = topZf + 0.05;
  const lipB = isoStr(x0, yF + 0.04, lipBz, scale, cx, cy);
  const lipB2 = isoStr(x1, yF + 0.04, lipBz, scale, cx, cy);

  const DARK = { topFill: PAPER_SHADE_DARK, frontFill: PAPER_SHADE_DARK, rightFill: PAPER_SHADE_DARK };
  const WOOD = { topFill: PAPER_SHADE_MID,  frontFill: PAPER_SHADE_LIGHT, rightFill: PAPER_SHADE_MID };
  return `
    <g class="fl-glyph fl-glyph-lectern" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      ${boxPaths(plinth, DARK)}
      ${boxPaths(column, WOOD)}
      <!-- angled reading top (accent = active radiating surface) -->
      <path d="M${TL} L${TR} L${BR} L${BL} Z" fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
      <!-- front lip -->
      <path d="M${lipF} L${lipF2} L${lipB2} L${lipB} Z" fill="${PAPER_SHADE_MID}" />
    </g>`;
}

// --- Bookshelf (loaded) ----------------------------------------------
// Shelf compartments with book spines on the front face. Front = accent
// (loaded books are the acoustically active absorbing/diffusing surface).
function glyph_bookshelf(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 1.0, D = 0.30, H = 2.0;
  const STROKE = 1.25;
  const body = boxFaces(0, 0, 0, W, D, H, scale, cx, cy);
  const SHELVES = 5;
  const shelfPaths = [];
  const bookPaths = [];
  for (let s = 0; s < SHELVES; s++) {
    const zLo = (s / SHELVES) * H + 0.04;
    const zHi = ((s + 1) / SHELVES) * H - 0.04;
    // Shelf divider line across the front face.
    const dzL = isoStr(0.02, 0, zLo - 0.04, scale, cx, cy);
    const dzR = isoStr(W - 0.02, 0, zLo - 0.04, scale, cx, cy);
    shelfPaths.push(`<path d="M${dzL} L${dzR}" stroke="${INK}" stroke-width="1.0" />`);
    // Book spines — vertical accent ticks of varying height across the bay.
    const nBooks = 7;
    for (let b = 0; b < nBooks; b++) {
      const xb = 0.06 + (b + 0.5) * ((W - 0.12) / nBooks);
      // Vary spine top so the row reads as books, not a comb.
      const topZ = zHi - 0.02 - (((b * 7 + s * 3) % 5) * 0.018);
      const p0 = isoStr(xb, 0, zLo, scale, cx, cy);
      const p1 = isoStr(xb, 0, topZ, scale, cx, cy);
      bookPaths.push(`<path d="M${p0} L${p1}" stroke="${ACCENT}" stroke-width="1.5" stroke-linecap="butt" />`);
    }
  }
  return `
    <g class="fl-glyph fl-glyph-bookshelf" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${body.right}" fill="${PAPER_SHADE_DARK}" />
      <path d="${body.front}" fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
      <path d="${body.top}"   fill="${PAPER_SHADE_MID}" />
      ${shelfPaths.join('')}
      ${bookPaths.join('')}
    </g>`;
}

// --- Server rack (42U, perforated front) -----------------------------
// Rack-frame read: two vertical mounting rails + many fine U-slot rows on
// a perforated front face (accent). More, finer rows than the generic 4.
function glyph_serverRack(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 0.60, D = 1.0, H = 2.0;
  const STROKE = 1.25;
  const body = boxFaces(0, 0, 0, W, D, H, scale, cx, cy);
  // Two mounting rails — slim vertical lines just inside the front edges.
  const railX = [0.10, W - 0.10];
  const rails = railX.map(rx => {
    const p0 = isoStr(rx, 0, 0.06, scale, cx, cy);
    const p1 = isoStr(rx, 0, H - 0.06, scale, cx, cy);
    return `<path d="M${p0} L${p1}" stroke="${INK}" stroke-width="1.4" />`;
  });
  // U-slot rows — 21 fine horizontal ticks between the rails (reads as a
  // dense 42U front without drawing all 42 at thumbnail size).
  const ROWS = 21;
  const uRows = [];
  for (let i = 1; i < ROWS; i++) {
    const z = (i / ROWS) * (H - 0.12) + 0.06;
    const p0 = isoStr(0.12, 0, z, scale, cx, cy);
    const p1 = isoStr(W - 0.12, 0, z, scale, cx, cy);
    uRows.push(`<path d="M${p0} L${p1}" stroke="${ACCENT}" stroke-width="0.6" stroke-linecap="butt" />`);
  }
  return `
    <g class="fl-glyph fl-glyph-server-rack" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${body.right}" fill="${PAPER_SHADE_DARK}" />
      <path d="${body.front}" fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
      <path d="${body.top}"   fill="${PAPER_SHADE_MID}" />
      ${rails.join('')}
      ${uRows.join('')}
    </g>`;
}

// --- Prayer mat (with subtle mihrab arch) ----------------------------
// Flat per-m² mat; adds a faint mihrab-arch motif on the top face so it
// reads as a prayer mat, not a generic rug. Accent stays on the top.
function glyph_prayerMat(item, { scale = 70, cx = 55, cy = 110 } = {}) {
  const W = 1.0, D = 1.0, H = 0.02;
  const STROKE = 1.25;
  const pad = boxFaces(0, 0, 0, W, D, H, scale, cx, cy);
  // Mihrab arch: a niche pointing toward the front (small y). Build it as
  // a path on the top face — two uprights + a pointed apex.
  const az = H;
  const aL = isoStr(0.30, D - 0.20, az, scale, cx, cy);   // upright base left (back)
  const aLf = isoStr(0.30, 0.30, az, scale, cx, cy);       // upright top left (front)
  const apex = isoStr(0.50, 0.12, az, scale, cx, cy);      // pointed apex (front centre)
  const aRf = isoStr(0.70, 0.30, az, scale, cx, cy);       // upright top right
  const aR = isoStr(0.70, D - 0.20, az, scale, cx, cy);    // upright base right
  return `
    <g class="fl-glyph fl-glyph-prayer-mat" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="${pad.right}" fill="${PAPER_SHADE_MID}" />
      <path d="${pad.front}" fill="${PAPER_SHADE_MID}" />
      <path d="${pad.top}"   fill="${PAPER_SHADE_LIGHT}" stroke="${ACCENT}" stroke-width="1.6" />
      <!-- mihrab arch motif (faint accent) -->
      <path d="M${aL} L${aLf} L${apex} L${aRf} L${aR}" stroke="${ACCENT}" stroke-width="0.9" fill="none" opacity="0.75" />
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
  // Theatre-seat family (v=714) — uses the same iso glyph as 'seat' for
  // now since the 2D viewport / catalogue card render at low resolution.
  // 3D viewport uses a dedicated cinema-chair builder. A bespoke
  // theatre-glyph (pedestal feet + tall back) is a Maya UX call for a
  // later pass.
  'theater-seat': glyph_seat,
  'slab-on-legs': glyph_slabOnLegs,
  'vertical-box': glyph_verticalBox,
  'flat-pad': glyph_flatPad,
};

// --- Public registry -------------------------------------------------
// Per-id overrides (hand-drawn glyphs that trump the family default).
// buildGlyph checks this map FIRST. These keep visual.family UNCHANGED
// in the catalogue — the family glyphs remain the fallback for any row
// that doesn't have a bespoke override here.
//
// Maya, 2026-05-30 — redesign after the "cacat" thumbnail report:
//   - theater-seat (cinema fold-up) vs office-chair (task chair) were
//     rendering the SAME generic chair; now visually distinct + each
//     matches its 3D builder silhouette.
//   - occupied vs empty were identical; occupied rows now carry a
//     seated-occupant silhouette.
//   - audience-block was a flat diamond (flat-pad clamps height); now a
//     cluster of seated occupants on a 1 m² tile at full block height.
//   - lectern was a spindly table (slab-on-legs); now an angled reading
//     top on a tapered podium.
//   - bookshelf / server-rack read generic; now shelf-spines and a dense
//     U-slot rack frame respectively.
//   - prayer mat gains a faint mihrab-arch motif.
const GLYPHS = new Map([
  ['theater-seat-upholstered-occupied', (_item, opts) => glyph_theaterSeatGlyph(true,  opts)],
  ['theater-seat-upholstered-empty',    (_item, opts) => glyph_theaterSeatGlyph(false, opts)],
  ['office-chair-padded-occupied',      (_item, opts) => glyph_officeChairGlyph(true,  opts)],
  ['office-chair-padded-empty',         (_item, opts) => glyph_officeChairGlyph(false, opts)],
  ['audience-block-per-m2-occupied',    glyph_audienceBlock],
  ['lectern-wood',                      glyph_lectern],
  ['bookshelf-loaded-1x2',              glyph_bookshelf],
  ['server-rack-42u-perforated',        glyph_serverRack],
  ['prayer-mat-unrolled-per-m2',        glyph_prayerMat],
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
