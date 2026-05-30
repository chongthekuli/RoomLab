// Regression: a listener INSIDE a closed (roofed) building must NOT read
// louder than a listener OUTSIDE in the adjacent arcade — and, after the
// 2026-05-30 fix, must read MUCH lower (transmission-loss-bound).
//
// History:
//   - Original bug (2026-05-24): interior at (1,14,1.7) read 89 dB vs
//     arcade (-1.5,9,1.7) at 84 dB — INVERSION. The dominant path bent over
//     the building WALL TOP edge into the interior with near-zero Maekawa IL.
//   - v=647 band-aid: a flat 16 dB TOP_EDGE_IL_FLOOR clamped that path and an
//     inner-eave dedupe removed a double-count. It hid the inversion (76 vs 78)
//     but the interior was still ~37 dB too loud.
//   - v=727 REAL fix (Dr. Chen 2026-05-30): the over-the-wall-TOP path into a
//     ROOFED interior is unphysical — the wall top is capped by the ceiling, so
//     that path must pay the ceiling transmission loss. interiorRoofDiffraction
//     -TL_db (spl-calculator) resolves the ceiling material (open-air → 0 TL →
//     path survives for a roofless courtyard; concrete → ~53 → path dies) and
//     threads it into computeDiffractionContributions (interiorTopEdgeTL_db).
//     The parent-wall TOP-edge 16 dB floor is DROPPED (it was masking this) and
//     replaced by the band-shaped thickBarrierIL thickness bonus. The
//     VERTICAL_EDGE floor and the arcade-roof overhead floor are RETAINED
//     (different mechanisms, separate tasks).
//
// Result: roofed interior is TL-bound (~30-40 dB), arcade unchanged (~73-78),
// and an OPEN-TOP courtyard interior stays loud (~83-86) — the (C) control
// proves the penalty is gated on the ceiling MATERIAL, not bare geometry.

import { readFileSync } from 'node:fs';

globalThis.localStorage = (() => {
  const _s = { PHYSICS_P1_5: '1' };
  return {
    getItem: (k) => _s[k] ?? null,
    setItem: (k, v) => { _s[k] = String(v); },
    removeItem: (k) => { delete _s[k]; },
  };
})();

const { computeMultiSourceSPL, computeRoomConstant } = await import('../js/physics/spl-calculator.js');

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 92, directivity_index_db: 8 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      '1000': [[-15,-10,-6,-10,-15],[-6,-3,0,-3,-6],[-15,-10,-6,-10,-15]],
    },
  },
};

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// =============================================================================
// (A) Source-grep: the v=727 roof-TL mechanism + inner-eave dedupe present
// =============================================================================
const diffSrc = readFileSync('./js/physics/diffraction.js', 'utf8');
const splSrc = readFileSync('./js/physics/spl-calculator.js', 'utf8');
check('(A) enumerateRoofPerimeterEdges takes a room arg (for inner-edge dedup)',
  /function enumerateRoofPerimeterEdges\s*\(\s*refl\s*,\s*room\s*\)/.test(diffSrc));
check('(A) inner-edge dedupe: skipAxis/skipValue logic present',
  /skipAxis\s*=\s*['"](x|y)['"]/.test(diffSrc));
check('(A) diffraction accepts the interior roof-TL term (interiorTopEdgeTL_db)',
  /interiorTopEdgeTL_db/.test(diffSrc));
check('(A) spl-calculator resolves the ceiling TL (interiorRoofDiffractionTL_db)',
  /interiorRoofDiffractionTL_db/.test(splSrc));

function surauRoom(enclosure) {
  return {
    shape: 'rectangular', width_m: 18, height_m: 4.5, depth_m: 17.7, enclosure,
    surfaces: {
      floor: 'carpet-heavy-underlay', ceiling: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east: 'concrete-painted', wall_west: 'concrete-painted',
    },
    surauStructure: {
      arcade: { sides: ['south','east','west'], depth_m: 3, roof_height_m: 4.4 },
      materials: { arcade_roof: 'concrete-painted', podium_top: 'concrete-painted' },
      podium: { extension_m: 3 },
    },
  };
}
// 4 azan horns at minaret (NW corner OUTSIDE building per surau preset).
const horns = [
  { modelUrl: 'x', position: { x: -1.2, y: 19.9, z: 7 }, aim: { yaw: 0,   pitch: -12 }, power_watts: 80 },
  { modelUrl: 'x', position: { x: -0.2, y: 18.9, z: 7 }, aim: { yaw: 90,  pitch: -12 }, power_watts: 80 },
  { modelUrl: 'x', position: { x: -1.2, y: 17.9, z: 7 }, aim: { yaw: 180, pitch: -12 }, power_watts: 80 },
  { modelUrl: 'x', position: { x: -2.2, y: 18.9, z: 7 }, aim: { yaw: 270, pitch: -12 }, power_watts: 80 },
];
const INSIDE = { x: 1, y: 14, z: 1.7 };     // 1 m inside the west wall
const OUTSIDE = { x: -1.5, y: 9, z: 1.7 };  // under the west arcade
function splAt(room, pos, freq) {
  const R = computeRoomConstant(room, materials, freq, []);
  return computeMultiSourceSPL({ sources: horns, getSpeakerDef: () => speaker, listenerPos: pos, freq_hz: freq, room, materials, roomConstantR: R });
}

// =============================================================================
// (B) Roofed building — interior must be TL-bound, far below the arcade, at
//     every band. (Dr. Chen 2026-05-30 matrix.)
// =============================================================================
const roofed = surauRoom(undefined);   // closed: concrete ceiling
for (const freq of [1000, 2000, 4000]) {
  const inside = splAt(roofed, INSIDE, freq);
  const outside = splAt(roofed, OUTSIDE, freq);
  // B1 — strong isolation (the core regression): interior ≥ 15 dB below the
  // arcade. Was the inversion (inside > outside) pre-fix; ~37 dB gap now.
  check(`(B1 @${freq}Hz) inside ≤ outside − 15 dB (no inversion, strong isolation)`,
    inside <= outside - 15, `inside=${inside.toFixed(1)}, outside=${outside.toFixed(1)}, Δ=${(inside - outside).toFixed(1)}`);
  // B2 — interior is transmission-loss-bound, not diffraction-bound: high-30s/
  // low-40s at 1k, falling at HF. < 50 → roof path suppressed; > 25 → not
  // collapsed to silence (real through-TL-53 concrete field).
  check(`(B2 @${freq}Hz) 25 < inside < 50 dB (TL-bound, not roof-diffraction-bound)`,
    inside > 25 && inside < 50, `inside=${inside.toFixed(1)}`);
  // B3 — arcade exterior cell UNCHANGED (porch lift + real open-edge diffraction
  // intact). Blast-radius tripwire: the fix must not touch exterior paths.
  check(`(B3 @${freq}Hz) outside > 60 dB (arcade unchanged)`,
    outside > 60, `outside=${outside.toFixed(1)}`);
}

// =============================================================================
// (C) OPEN-TOP control — a roofless courtyard interior must NOT be roof-
//     penalised (the over-the-top path is physical there). Proves the penalty
//     is gated on the resolved ceiling MATERIAL (open-air, TL 0), not geometry
//     — i.e. mechanism (b) add-roof-TL, not (a) hard-reject.
// =============================================================================
{
  const openTop = surauRoom('outdoor');  // ceiling forced to open-air (TL 0)
  const insideOpen = splAt(openTop, INSIDE, 1000);
  const insideClosed = splAt(roofed, INSIDE, 1000);
  check('(C) open-top interior ≫ roofed interior (+10 dB): penalty is material-gated',
    insideOpen > insideClosed + 10,
    `open=${insideOpen.toFixed(1)}, roofed=${insideClosed.toFixed(1)}, Δ=${(insideOpen - insideClosed).toFixed(1)}`);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${failed === 0 ? 'all checks passed' : failed + ' failed'}`);
if (failed > 0) process.exit(1);
