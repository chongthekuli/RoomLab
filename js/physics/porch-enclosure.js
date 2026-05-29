// js/physics/porch-enclosure.js
//
// Phase 8 Step 4 (Dr. Chen audit 2026-05-24) — porch / arcade partial-
// enclosure reverberant lift. Per the user's surau test:
//   - Phase 8 Step 1 (overhead-reflection.js) addresses the case where
//     a source sits ABOVE a roof (transmission through the roof) or
//     IN the arcade space (first-order specular reflection off the
//     roof). It does NOT cover the typical case — an indoor PA at
//     z ≈ 2.5 m firing through the building wall to a listener under
//     the arcade. For that geometry, no analytical path crosses or
//     reflects off the arcade roof at all, so the roof material has
//     zero effect on the cell. That was the user-reported "still the
//     same" outcome at v=639.
//
//   - Real porches retain energy via MULTIPLE BOUNCES off the present
//     surfaces (roof, podium, back wall). Beranek-style "semi-open
//     enclosure" treats the open faces as α = 1 absorbers (energy
//     radiates out and doesn't return). The Sabine room constant of
//     this partial enclosure determines a per-band reverberant lift
//     on top of the direct-path SPL reaching the porch.
//
// Mechanism (partial-enclosure Sabine — present-surface room constant +
// open-face energy-fraction scaling; Beranek "semi-open enclosure" adapted):
//   A_present[band] = Σ (α_i[band] · S_i)  over PRESENT surfaces (roof, podium, back)
//   ᾱ_present       = A_present / S_present
//   R_present       = A_present / (1 − ᾱ_present)        (Sabine room constant)
//   closedLift_dB   = 10 · log10(4 / R_present)          (reverb-field term)
//   lift_dB[band]   = closedLift_dB + 10·log10(S_present/S_total)  (open-face loss)
//   L_drive         = direct-path SPL from source to porch entry midpoint
//   L_porch_rev     = L_drive + lift_dB
//   SPL_cell        = energy_sum(direct_at_cell, L_porch_rev)
//
// WHY NOT the pure Beranek S_open-at-α=1 form (A = Σα·S_present + 1·S_open):
//   In that form the α=1 open faces sit in the SAME A sum as the roof's α·S,
//   so roof-material changes barely move ᾱ — the "roof change had <0.1 dB
//   effect" user report (v=641). The present-surface-R + energy-scale form
//   above keeps the roof an AUDIBLE lever, which is the correct behaviour in
//   this module's gated regime: it only fires when openFrac ≤ 0.6 (≥40%
//   enclosed), where the roof genuinely matters. Dr. Chen re-reviewed this
//   2026-05-29 and ENDORSED the implemented form over her earlier audit's
//   S_open suggestion — the two agree as openFrac→0.6 and diverge as the
//   porch gets more enclosed, where S_open would under-read the lift by
//   ~2 dB on a typical 0.6-enclosure-factor cell. See docs/NYMPHYSICS.md
//   Part 3 + docs/NYMPHYSICS_AUDIT_2026-05-29.md.
//
// LIMITATION: for a porch open ABOVE the 0.6 gate this module returns zero
//   lift (correct — it is basically outdoors; the roof legitimately stops
//   being a lever there). That is physics, not a bug.
//
// Detection (Dr. Chen Q5):
//   Cell is in a partial enclosure iff
//     (1) cell xy ∈ arcade roof polygon (re-used from Step 1 extractor),
//     (2) cell z < roof_height_m (under the roof),
//     (3) ≥ 3 of {top, bottom, +lateral-back, −lateral-front, ±lateral-ends}
//         surfaces are PRESENT,
//     (4) open fraction (S_open / S_total) ≤ 0.6 — otherwise it's
//         basically outdoors and the lift is meaningless.
//
// Frequency dependence:
//   Per-band. α[band] from materials.json `absorption[7]` array.
//
// Cell uniformity:
//   The reverberant component is uniform across all cells inside the
//   porch polygon — that's the room-constant assumption (Sabine).
//   Per-cell variation comes from the direct path only.

import { extractOverheadReflectors, pointInPolygon2D } from './overhead-geometry.js';
import { bandIndexForFreq } from './wall-path.js';   // Phase A2 — was an inline duplicate

// ---------------------------------------------------------------------------
// Resolve a material's per-band absorption from materials.json. Same
// convention as overhead-reflection.js — try `absorption[band]` first
// (the actual catalogue field), then legacy `absorption_coeff` fallbacks.
// ---------------------------------------------------------------------------

function getAlphaBand(materials, materialId, bandIdx) {
  const mat = materials?.byId?.[materialId];
  if (!mat) return 0.05;
  const bandArray = Array.isArray(mat.absorption) ? mat.absorption
                  : (Array.isArray(mat.absorption_coeff) ? mat.absorption_coeff : null);
  if (bandArray && Number.isFinite(bandArray[bandIdx])) {
    return Math.max(0, Math.min(1, bandArray[bandIdx]));
  }
  if (Number.isFinite(mat.absorption_coeff)) return mat.absorption_coeff;
  return 0.05;
}

// ---------------------------------------------------------------------------
// Build a partial-enclosure spec for each arcade roof polygon. Returns
// an array of porches, one per arcade side (south / east / west).
// Each porch carries the geometry needed for both detection (polygon +
// z range) and absorption (the 5-surface inventory + α per band).
// ---------------------------------------------------------------------------

function arcadeSideBackWallMaterial(room, side) {
  const surfaces = room?.surfaces || {};
  // Compass convention from scene.js sideSpec / overhead-geometry.js:
  //   south arcade backs onto wall_north (state y=0 face) — but in scene
  //   convention, 'wall_north' is the state-y=0 face (the entrance side).
  //   The arcade on the 'south' (preset's compass-south side) BACKS the
  //   building at wall_north (state-y=0). See the compass swap in
  //   room-shape.js:716-719.
  //
  // Map arcade side → building wall slot:
  //   arcade.sides 'south' (preset south = state y=0)  → wall_north slot
  //   arcade.sides 'north' (preset north = state y=D)  → wall_south slot (rare; qibla)
  //   arcade.sides 'east'  (state x=W)                  → wall_east slot
  //   arcade.sides 'west'  (state x=0)                  → wall_west slot
  const map = { south: 'wall_north', north: 'wall_south', east: 'wall_east', west: 'wall_west' };
  const slotKey = map[side] || 'wall_north';
  const slot = surfaces[slotKey];
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return 'gypsum-board';
}

export function extractPorches(room) {
  const out = [];
  const s = room?.surauStructure;
  if (!s) return out;
  const ar = s.arcade;
  if (!ar || !Array.isArray(ar.sides) || ar.sides.length === 0) return out;

  const reflectors = extractOverheadReflectors(room).filter(r => r.kind === 'arcade_roof');
  if (reflectors.length === 0) return out;

  const depth = Number(ar.depth_m) || 3;
  const roofH = Number(ar.roof_height_m) || 4.4;
  const roofMatId = s.materials?.arcade_roof || 'gypsum-board';
  const podiumMatId = s.materials?.podium_top || room.surfaces?.floor || 'concrete-painted';

  for (const refl of reflectors) {
    // Roof polygon footprint (4 vertices, axis-aligned in state coords
    // by construction from overhead-geometry.js).
    const verts = refl.vertices;
    const xs = verts.map(v => v.x);
    const ys = verts.map(v => v.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const polyW = maxX - minX;
    const polyD = maxY - minY;
    const roofArea = polyW * polyD;
    if (roofArea < 0.5) continue;   // degenerate

    // Build the 5-surface inventory.
    //   top    = roof          α = roofMatId      S = roofArea
    //   bottom = podium        α = podiumMatId    S = roofArea (same footprint)
    //   back   = building wall α = back wall slot S = (side-length) × roofH
    //   front  = open to outside (perpendicular to building, outer arcade line)
    //   ends   = open at both side ends
    //
    // For sides 'south' / 'north': side-length = polyW (along x); end-faces along y.
    // For sides 'east'  / 'west' : side-length = polyD (along y); end-faces along x.
    //
    // Back-wall area: the arcade's contact length along the building × roofH.
    const isLateralEW = (refl.side === 'east' || refl.side === 'west');
    const backLen = isLateralEW ? polyD : polyW;
    const backArea = backLen * roofH;
    const frontArea = backLen * roofH;             // open outer line
    const endsArea = 2 * depth * roofH;            // two end faces
    const backMatId = arcadeSideBackWallMaterial(room, refl.side);

    out.push({
      side: refl.side,
      polygon: verts,         // for point-in-polygon detection (xy)
      z_floor: 0,             // podium top
      z_ceil: roofH,          // arcade roof underside
      bounds: { minX, maxX, minY, maxY },
      surfaces: {
        roof:    { materialId: roofMatId,   area_m2: roofArea },
        podium:  { materialId: podiumMatId, area_m2: roofArea },
        back:    { materialId: backMatId,   area_m2: backArea },
      },
      open: {
        front_m2: frontArea,
        ends_m2:  endsArea,
      },
      // Pre-compute per-band Sabine quantities below; cached on the porch
      // object so per-cell lookups don't redo the arithmetic.
      _cachedBands: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-band Sabine A_porch + lift. Caches per-band results onto the porch
// object so repeated lookups (one per cell in computeSPLGrid) are cheap.
// ---------------------------------------------------------------------------
//
// One-shot diagnostic: when this module loads, log a line so the user can
// verify in DevTools that v=642+ is running. If the browser serves a
// cached older porch-enclosure.js this line is absent.
let _bandsLoggedForKey = null;
function _logPorchBandsOnce(porch, bandsInfo) {
  // Log once per unique (side, roof, podium, back) tuple so a
  // material-change rebuild emits a fresh line.
  const key = `${porch.side}|${porch.surfaces.roof.materialId}|${porch.surfaces.podium.materialId}|${porch.surfaces.back.materialId}`;
  if (_bandsLoggedForKey === key) return;
  _bandsLoggedForKey = key;
  if (typeof console === 'undefined') return;
  const lift1k = bandsInfo.per[3]?.lift_dB?.toFixed(2);
  const lift4k = bandsInfo.per[5]?.lift_dB?.toFixed(2);
  console.log(
    `[porch v=642] ${porch.side} arcade — roof=${porch.surfaces.roof.materialId} ` +
    `enclosureFactor=${bandsInfo.enclosureFactor.toFixed(2)} ` +
    `lift_dB @ 1k=${lift1k}, @ 4k=${lift4k}`
  );
}

function ensurePorchBands(porch, materials) {
  if (porch._cachedBands) return porch._cachedBands;
  const bands = materials?.frequency_bands_hz;
  if (!Array.isArray(bands)) return null;
  const S_present = porch.surfaces.roof.area_m2 + porch.surfaces.podium.area_m2 + porch.surfaces.back.area_m2;
  const S_open    = porch.open.front_m2 + porch.open.ends_m2;
  const S_total   = S_present + S_open;
  // Detection threshold (Dr. Chen Q5 #4): open fraction ≤ 0.6 to qualify
  // as a partial enclosure. Beyond that, we're basically outdoors — no
  // meaningful lift. Mark the porch as inactive so the per-cell test
  // short-circuits.
  const openFrac = S_open / S_total;
  const active = openFrac <= 0.6;
  // Fraction of incident energy that the present surfaces "trap" for
  // multi-bounce buildup. A closed room (no openings) → 1.0; a fully
  // open space → 0.0; a 50%-open porch → 0.5. This is the
  // physically-grounded scaling factor — Sabine-with-open-α=1 would
  // overdamp the lift to invisible levels (the open faces wash out the
  // closed-surface α budget); Sabine-with-closed-surfaces-only would
  // overstate the lift (treats the porch as a sealed room). The
  // enclosure_factor blend is the Beranek partial-enclosure heuristic.
  const enclosureFactor = Math.max(0, Math.min(1, S_present / S_total));

  const per = bands.map((_, bandIdx) => {
    const alphaRoof   = getAlphaBand(materials, porch.surfaces.roof.materialId,   bandIdx);
    const alphaPodium = getAlphaBand(materials, porch.surfaces.podium.materialId, bandIdx);
    const alphaBack   = getAlphaBand(materials, porch.surfaces.back.materialId,   bandIdx);
    // Closed-enclosure Sabine — only the present surfaces. Compute the
    // room constant as if the porch were a sealed box; then scale the
    // resulting lift by enclosure_factor so the open faces still
    // dampen the buildup proportionally. This makes the roof material
    // a measurable lever on covered-cell SPL (user-reported v=641:
    // arcade roof material change had < 0.1 dB effect because the
    // open-α=1 dampening swamped the closed-surface α budget).
    const A_closed = alphaRoof   * porch.surfaces.roof.area_m2
                   + alphaPodium * porch.surfaces.podium.area_m2
                   + alphaBack   * porch.surfaces.back.area_m2;
    const alphaAvgClosed = Math.max(1e-6, Math.min(0.999, A_closed / S_present));
    const R_closed = A_closed / (1 - alphaAvgClosed);
    const closedLift_dB = R_closed > 0 ? 10 * Math.log10(4 / R_closed) : -Infinity;
    // Partial-enclosure scaling — multiply the LINEAR (energy) reverb
    // power by enclosure_factor, then convert back to dB:
    //   lift_dB = closedLift_dB + 10·log10(enclosure_factor)
    // (Equivalent to multiplying the reverberant pressure² by
    // enclosure_factor, which is the correct physical operation —
    // an open partial enclosure traps only that fraction of energy.)
    //
    // For surau west arcade (enclosure_factor ≈ 0.63):
    //   concrete porch (closedLift ≈ +1 dB) → effective ≈ −1 dB
    //   acoustic-tile  (closedLift ≈ -10 dB) → effective ≈ −12 dB
    // Δ ≈ 11 dB on the LIFT, which translates to ~3-4 dB on the cell
    // SPL when summed with direct + diffraction. Matches Dr. Chen audit
    // estimate "+2 to +4 dB for typical covered porches."
    const energyScale_dB = 10 * Math.log10(Math.max(1e-6, enclosureFactor));
    const lift_dB = Number.isFinite(closedLift_dB) ? closedLift_dB + energyScale_dB : -Infinity;
    // Cache the underlying Sabine quantities for diagnostics.
    return { A_closed, alphaAvgClosed, R_closed, closedLift_dB, lift_dB };
  });
  porch._cachedBands = { active, openFrac, S_total, S_present, S_open, enclosureFactor, per };
  _logPorchBandsOnce(porch, porch._cachedBands);
  return porch._cachedBands;
}

// ---------------------------------------------------------------------------
// Per-cell membership: is the listener position inside this porch's
// partial-enclosure volume?
// ---------------------------------------------------------------------------

export function listenerInPorch(porch, listenerPos) {
  if (!porch || !listenerPos) return false;
  if (!Number.isFinite(listenerPos.z)) return false;
  if (listenerPos.z >= porch.z_ceil) return false;
  if (listenerPos.z < porch.z_floor) return false;
  return pointInPolygon2D(listenerPos.x, listenerPos.y, porch.polygon);
}

// ---------------------------------------------------------------------------
// PUBLIC — per-source porch reverberant pressure² contribution. Returns 0
// when no porches contribute (the common non-surau case) or when the
// listener is not in any partial enclosure.
//
// `getDirectSplDb(srcStateLike, listenerPos)` — caller-supplied closure
// that returns the direct-path SPL in dB from a source to a position.
// Wired by the SPL pipeline to call computeDirectSPL.spl_db, so this
// module stays free of a circular dependency on spl-calculator.
// ---------------------------------------------------------------------------

export function computePorchReverbPower({
  src, listenerPos, freq_hz, room, materials, porches = null,
  getDirectSplDb,
  // Phase A3: optional per-frame pre-computed drives for THIS source —
  // [porchIdx] → drive_dB. When provided, getDirectSplDb is not called.
  // Caller (precomputeSPLContext) computes drives once per frame using
  // the same physics stack the closure used.
  precomputedDrives_dB = null,
}) {
  const list = porches || extractPorches(room);
  if (list.length === 0) return 0;
  // Either a pre-computed drive array OR a live closure is required.
  if (!precomputedDrives_dB && typeof getDirectSplDb !== 'function') return 0;

  // Phase A2: use the canonical bandIndexForFreq.
  if (!Array.isArray(materials?.frequency_bands_hz) || materials.frequency_bands_hz.length === 0) return 0;
  const bandIdx = bandIndexForFreq(materials, freq_hz);

  let pressureSum = 0;
  for (let pIdx = 0; pIdx < list.length; pIdx++) {
    const porch = list[pIdx];
    if (!listenerInPorch(porch, listenerPos)) continue;
    const bandsInfo = ensurePorchBands(porch, materials);
    if (!bandsInfo || !bandsInfo.active) continue;
    const lift_dB = bandsInfo.per[bandIdx]?.lift_dB;
    if (!Number.isFinite(lift_dB)) continue;

    let L_drive;
    if (precomputedDrives_dB && Number.isFinite(precomputedDrives_dB[pIdx])) {
      // Fast path — drive already computed by precomputeSPLContext.
      L_drive = precomputedDrives_dB[pIdx];
    } else {
      // Fallback — compute drive inline via the closure. Caller hasn't
      // pre-computed (per-listener computeMultiSourceSPL path, tests).
      // Porch ENTRY midpoint — Dr. Chen Q4(b) — polygon centroid at
      // z = roof/2 gives a stable "porch midpoint" that's robust to
      // source position.
      const cx = (porch.bounds.minX + porch.bounds.maxX) / 2;
      const cy = (porch.bounds.minY + porch.bounds.maxY) / 2;
      const cz = porch.z_ceil / 2;
      const drivePoint = { x: cx, y: cy, z: cz };
      L_drive = getDirectSplDb(src, drivePoint);
    }
    if (!Number.isFinite(L_drive)) continue;
    const L_porch_rev = L_drive + lift_dB;
    pressureSum += Math.pow(10, L_porch_rev / 10);
  }
  return pressureSum;
}
