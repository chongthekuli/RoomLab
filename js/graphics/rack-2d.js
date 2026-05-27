// Top-down rack footprint renderer — shared by the 2D viewport
// (js/graphics/room-2d.js) AND the print plan SVG (js/ui/print-plan-svg.js).
//
// Cross-surface convention owner: Sam (qa-engineer). Anything that
// renders the rack footprint on >= 2 surfaces lives here so the two
// surfaces cannot drift on:
//
//   • origin           — centre of the rack base on the floor
//   • front-edge cue   — which edge of the footprint is the front door
//   • hinge-side cue   — which corner of the front edge holds the hinge axis
//   • closed footprint — outer_w_mm × outer_d_mm only; no door-swing arc
//
// 3D coordinate frame (Viktor, js/graphics/rack-render.js):
//   group origin = base centre on floor
//   +X = width (right when looking at the front)
//   +Y = up
//   +Z = depth (REAR-pointing). Front face is at -Z; rear face is at +Z.
//
// Mapping to state plan (top-down):
//   state.x = rack.position.x (right on the printed page after the
//             scene.scale.x = -1 mirror handles 3D parity — the 2D
//             viewport's own convention is state +x → screen RIGHT
//             pre-rotation, which IS the 3D appearance after the mirror)
//   state.y = rack.position.y (north on the page; +y → screen UP via
//             the surface-specific Y-flip)
//   rack.yaw_deg = rotation about +Y up-axis (matches scene.js
//                  `g.rotation.y = yaw_deg * π/180`)
//
// At yaw_deg = 0, the rack's local -Z (front) faces world -Z, which
// scene.js maps to state -y (south). The 2D renderer mirrors this:
// at rotation 0 the FRONT EDGE of the footprint sits at the BOTTOM of
// the local rectangle (largest local-y inside the rect) — the SVG
// rotate() transform handedness then matches the 3D rotation.y
// handedness (both surfaces use the same numeric yaw_deg). Verified
// against the furniture renderer which uses the same pattern.
//
// Visual cues (Sam decision 2026-05-27):
//   FRONT edge   — thicker stroke ("door-line") on the front edge of
//                  the footprint. Conveys "this side opens" without
//                  adding text (rack footprints are small, ~0.6 m × 0.6
//                  to 1.0 m, text would crowd the room outline).
//   HINGE corner — small filled circle at the FRONT-LEFT corner (inside
//                  the footprint, offset inward by ~15% of the smaller
//                  footprint dim). Marks the hinge axis location for
//                  Viktor's slice-2 left-hinged front door. Door swings
//                  outward toward the viewer's RIGHT when open in 3D.
//
// Open-frame (legacy) racks have no door, but the front face is still
// where the 19" rails are — same renderer, same FRONT cue, same hinge
// dot (the dot doubles as "this is the rail side"). Treat open-frame
// the same as enclosed for footprint visualisation. Door-open state is
// 3D-only (slice 3); the 2D + print SVG always show a closed footprint.
//
// Coordinate convention for callers:
//   renderRackFootprintSVG(rack, rackDef, { cxPx, cyPx, mToPx, opts })
//     cxPx, cyPx   — SVG pixel of the rack centre (caller-projected)
//     mToPx        — metres → SVG pixels (single isotropic factor; the
//                    rack is symmetric enough that anisotropic scaling
//                    would distort the door-line)
//     opts.selected, opts.dataAttrs, opts.styleClass, opts.lineScale —
//                    surface-specific styling knobs (selection ring on
//                    the 2D viewport, monochrome stroke for print, etc.)
//
// Returns an SVG <g> string, or '' if rack / rackDef is missing required
// fields.

const FRONT_STROKE_MULT = 2.4;     // front edge line is 2.4× the side stroke
const SIDE_STROKE_MULT  = 1.0;
const HINGE_DOT_FRAC    = 0.10;    // dot radius = 10 % of min(w,d) footprint
const HINGE_INSET_FRAC  = 0.18;    // dot centre inset from front-left corner

/**
 * Resolve the catalogue definition for a rack. Accepts either the raw
 * catalogue JSON ({ schema_version, racks: { [key]: def } }) or a
 * Map<key, def>. Returns null if not found.
 */
export function lookupRackDef(catalogue, rackModelKey) {
  if (!catalogue || !rackModelKey) return null;
  if (typeof catalogue.get === 'function') return catalogue.get(rackModelKey) || null;
  if (catalogue.racks && typeof catalogue.racks === 'object') {
    return catalogue.racks[rackModelKey] || null;
  }
  return null;
}

/**
 * Footprint dimensions in METRES. Falls back to nominal 600 × 600 if
 * either field is missing — keeps a footprint visible even on a
 * malformed catalogue row (vs. silently rendering nothing).
 */
export function rackFootprintMetres(rackDef) {
  const w_mm = Number(rackDef?.outer_w_mm);
  const d_mm = Number(rackDef?.outer_d_mm);
  const w_m = Number.isFinite(w_mm) && w_mm > 0 ? w_mm / 1000 : 0.6;
  const d_m = Number.isFinite(d_mm) && d_mm > 0 ? d_mm / 1000 : 0.6;
  return { w_m, d_m };
}

/**
 * Emit the SVG <g> for one rack's top-down footprint.
 *
 * @param {object}  rack      — rack record from state.rackSystem.racks[i].
 *                              Reads: id, rackModelKey, yaw_deg, label.
 * @param {object}  rackDef   — catalogue row resolved via lookupRackDef().
 *                              Reads: outer_w_mm, outer_d_mm.
 * @param {object}  view
 * @param {number}  view.cxPx — SVG-pixel x of the rack centre
 * @param {number}  view.cyPx — SVG-pixel y of the rack centre
 * @param {number}  view.mToPx — metres → SVG pixels (isotropic)
 * @param {object}  [opts]
 * @param {boolean} [opts.selected]   — draw a selection halo (2D viewport)
 * @param {string}  [opts.fill]       — body fill colour
 * @param {string}  [opts.stroke]     — body stroke colour
 * @param {string}  [opts.frontStroke]— front-edge stroke colour
 * @param {string}  [opts.hingeFill]  — hinge dot fill colour
 * @param {string}  [opts.labelFill]  — label text colour
 * @param {string}  [opts.label]      — short label under the footprint
 * @param {number}  [opts.labelFontPx]— label font size in SVG units
 * @param {number}  [opts.lineScale]  — multiplier applied to all stroke widths
 *                                       (defaults to 1; print uses < 1)
 * @param {string}  [opts.styleClass] — CSS class for the outer <g>
 * @param {string}  [opts.dataAttrs]  — additional `key="value"` attrs (e.g.
 *                                       `data-rack-id="r1"`)
 *
 * @returns {string} SVG group as a string, or '' if dims are bad.
 */
export function renderRackFootprintSVG(rack, rackDef, view, opts = {}) {
  if (!rackDef || !view) return '';
  const { w_m, d_m } = rackFootprintMetres(rackDef);
  const mToPx = Number(view.mToPx);
  if (!Number.isFinite(mToPx) || mToPx <= 0) return '';
  const cxPx = Number(view.cxPx);
  const cyPx = Number(view.cyPx);
  if (!Number.isFinite(cxPx) || !Number.isFinite(cyPx)) return '';

  const wPx = w_m * mToPx;
  const dPx = d_m * mToPx;
  const rot = Number(rack?.yaw_deg) || 0;
  const sel = !!opts.selected;
  const lineScale = Number.isFinite(opts.lineScale) && opts.lineScale > 0 ? opts.lineScale : 1;

  // Local rectangle is centred at (0, 0) with extent ±wPx/2 in x and
  // ±dPx/2 in y. The FRONT edge is the local +y edge (the "bottom" of
  // the unrotated rect in SVG space). Why local +y for front:
  //
  //   3D: front faces -Z (rack-render.js). Group placed at world
  //       (state.x, state.z, state.y) and rotated about world +Y by
  //       yaw_deg (CCW looking down). At yaw=0, front faces world -Z
  //       = state -y = south.
  //   2D viewport: state +y is mapped to SVG -y (the surface-specific
  //       Y-flip). So "state -y" (south, where the front faces) maps
  //       to SVG +y (down on the page) = local +y of the un-rotated
  //       rect inside the <g transform="rotate()"> group. SVG rotate()
  //       handedness matches the 3D rotation.y handedness once the
  //       Y-flip is in place (verified against the furniture renderer
  //       which uses the identical pattern).
  //
  // So: the un-rotated front edge runs along local y = +dPx/2, x ∈
  // [-wPx/2, +wPx/2]. The hinge corner is at the LEFT end of that edge:
  // local (-wPx/2, +dPx/2). Door swings outward into local -y (away
  // from the rack interior) in 3D; 2D shows only the closed footprint.

  const halfW = wPx / 2;
  const halfD = dPx / 2;

  // Side stroke (the three non-front edges). Two paths: the body rect
  // (subtle stroke) and a separate THICK line on just the front edge.
  // Polygon traces the rect so we can give the front edge its own
  // stroke-width without re-stroking the whole outline.
  const sideStroke = (opts.stroke ?? '#3d4759');
  const sideStrokeWidth = (0.06 * lineScale).toFixed(3);
  const frontStroke = (opts.frontStroke ?? opts.stroke ?? '#0a0c10');
  const frontStrokeWidth = (0.06 * FRONT_STROKE_MULT * lineScale).toFixed(3);
  const bodyFill = (opts.fill ?? '#c8ccd4');

  // The hinge dot — front-LEFT corner of the un-rotated rect, with a
  // small inward inset so it visually sits on the rack, not on the
  // outside edge.
  const minDim = Math.min(wPx, dPx);
  const dotR = (minDim * HINGE_DOT_FRAC).toFixed(3);
  const inset = minDim * HINGE_INSET_FRAC;
  const dotCx = (-halfW + inset).toFixed(3);
  const dotCy = (halfD - inset).toFixed(3);
  const hingeFill = (opts.hingeFill ?? '#0a0c10');

  // Selection ring (2D viewport surface only — print never sets this).
  const selRing = sel
    ? `<rect x="${(-halfW - 2).toFixed(3)}" y="${(-halfD - 2).toFixed(3)}" `
      + `width="${(wPx + 4).toFixed(3)}" height="${(dPx + 4).toFixed(3)}" `
      + `fill="none" stroke="#ffb43a" stroke-width="${(0.10 * lineScale).toFixed(3)}" `
      + `stroke-dasharray="${(0.18 * lineScale).toFixed(3)},${(0.12 * lineScale).toFixed(3)}" />`
    : '';

  // Body rect — light steel fill, subtle stroke on three sides. The
  // front-edge thick line OVERSTROKES the front side so it reads as a
  // distinct "door-line".
  const body = `<rect x="${(-halfW).toFixed(3)}" y="${(-halfD).toFixed(3)}" `
    + `width="${wPx.toFixed(3)}" height="${dPx.toFixed(3)}" `
    + `fill="${bodyFill}" stroke="${sideStroke}" stroke-width="${sideStrokeWidth}" />`;

  // Thick FRONT edge — runs along local y = +halfD, x ∈ [-halfW, +halfW].
  // stroke-linecap="square" so the thick line ends flush with the body
  // corners (no rounded overshoot past the rectangle bounds).
  const frontLine = `<line x1="${(-halfW).toFixed(3)}" y1="${halfD.toFixed(3)}" `
    + `x2="${halfW.toFixed(3)}" y2="${halfD.toFixed(3)}" `
    + `stroke="${frontStroke}" stroke-width="${frontStrokeWidth}" stroke-linecap="square" />`;

  // Hinge dot at front-LEFT corner (Viktor's left-hinged front door).
  const hingeDot = `<circle cx="${dotCx}" cy="${dotCy}" r="${dotR}" `
    + `fill="${hingeFill}" stroke="none" />`;

  // Optional label below the footprint. Caller decides the text + size.
  const labelTxt = opts.label ? String(opts.label) : '';
  const labelFill = opts.labelFill ?? '#1a1a1a';
  const labelFontPx = Number.isFinite(opts.labelFontPx) && opts.labelFontPx > 0
    ? opts.labelFontPx
    : 10 * lineScale;
  // Label rides UNDER the front edge in local-y. Rotation applies to
  // the label too — this is consistent with how the rack faces when
  // yawed (the label text rotates with the front door). If the rack
  // is rotated past 90°, the text appears inverted; that's expected
  // top-down behaviour (matches furniture labels).
  const labelEl = labelTxt
    ? `<text x="0" y="${(halfD + labelFontPx * 1.4).toFixed(3)}" `
      + `text-anchor="middle" fill="${labelFill}" `
      + `font-size="${labelFontPx.toFixed(2)}">${escapeText(labelTxt)}</text>`
    : '';

  const classAttr = opts.styleClass ? ` class="${opts.styleClass}"` : '';
  const dataAttr = opts.dataAttrs ? ' ' + opts.dataAttrs : '';
  return `<g${classAttr}${dataAttr} transform="translate(${cxPx.toFixed(3)} ${cyPx.toFixed(3)}) rotate(${rot.toFixed(2)})">`
    + selRing
    + body
    + frontLine
    + hingeDot
    + labelEl
    + `</g>`;
}

/** Minimal SVG text escape — same set as print-plan-svg.js. */
function escapeText(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Constants exported for the cross-surface convention fixture so the
 * test can assert that BOTH 2D viewport and print plan SVG pull the
 * same numbers (cannot drift). Sam, slice 6.
 */
export const RACK_2D_CONSTANTS = Object.freeze({
  FRONT_STROKE_MULT,
  SIDE_STROKE_MULT,
  HINGE_DOT_FRAC,
  HINGE_INSET_FRAC,
  // The "shape contract" the convention fixture greps for. Bumping this
  // is a deliberate API break — the fixture's grep assertions reference
  // these names verbatim.
  FRONT_EDGE_LOCAL_Y: '+halfD',   // un-rotated front edge sits at local +y = +halfD
  HINGE_CORNER_LOCAL: '(-halfW, +halfD)',  // front-left = (-halfW, +halfD)
});
