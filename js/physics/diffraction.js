// js/physics/diffraction.js  [v=647 — interior-loudness inversion fixed]
//
// Diagnostic: one-shot log on module load so the user can verify in
// DevTools that they're actually running the v=645 build (ES module
// URLs aren't individually ?v=-busted in this project; a stale browser
// cache can serve the v<645 file even after main.js?v=645 loads fresh).
// Look for "[diffraction v=647]" in the console after a hard refresh.
if (typeof console !== 'undefined') {
  console.log('[diffraction v=647] loaded — vertical-edge IL floor = 16 dB');
}

// Maekawa-Tachibana single-edge barrier diffraction. Models sound
// bending around the top + free vertical edges of a wall when the
// straight-line path is blocked. Without this, the engine treats a
// wall as a hard acoustic shadow and the heatmap shows a sharp
// rectangular dark patch behind every wall — which doesn't match real
// measurements (sound diffracts; the shadow has a smooth gradient).
//
// References:
//   * Maekawa, 1968. "Noise reduction by screens." Applied Acoustics
//     1(3):157–173. The empirical fit used here.
//   * ISO 9613-2:1996 §7.4 ("Screening"). Adopts Maekawa.
//   * Pierce, Acoustics: An Introduction to Its Physical Principles
//     and Applications, §9.5 (wedge diffraction — DEFERRED P9).
//
// Formula (Dr. Chen, Tier 1a spec):
//
//   δ_m = (|S→E| + |E→R|) − |S→R|         path-length detour, metres
//   N   = 2·δ_m / λ                        Fresnel number, dimensionless
//   λ   = c(T) / f_band_centre             wavelength at band centre
//
//   IL_diff(N) =
//     0                                          when δ ≤ −λ/8     (deep lit zone)
//     linear interpolation 0 → 5                 when −λ/8 < δ ≤ 0 (smooth grazing handoff)
//     5 + 20·log10(√(2π·N) / tanh(√(2π·N)))     when δ > 0
//     clamp upper at 24 dB                        (single-edge measurement ceiling)
//
// The grazing handoff (linear 0→5 over the −λ/8 to 0 window) avoids
// a step discontinuity at the shadow boundary that would otherwise
// render as a visible 5-dB ring along every wall on the heatmap.
//
// Simplifications logged with the regression-curator (Theo):
//   P9  — Resolved in Tier 1a commit (e) for RECTANGULAR rooms via the
//         Pierce-Hadden wedge correction (wedgeIL + enumerateRoomCorners
//         + cornerIsInShadowPath + computeCornerDiffractionContributions
//         below). Polygon-room corners + standaloneEnclosure corners
//         remain deferred — see P14/P15.
//   P11 — Diffraction not modelled across coupled-rooms shared walls;
//         interior partitions use through-wall TL only.
//   P12 — Bottom-edge diffraction for raised standaloneEnclosures
//         (elev_m > 0) not enumerated. Top + verticals only.
//   P14 — Polygon-room exterior corner enumeration not implemented.
//         Needs interior-angle math + convex/concave sign handling.
//         Defer until a polygon-room preset ships outdoor listeners.
//   P15 — standaloneEnclosure exterior corners not enumerated. Same
//         wedge physics as P14, different geometry source.
//   P16 — Wedge correction frequency-independent (the +ΔIL term is
//         a pure geometric solid-angle factor). Real wedge diffraction
//         has a small UTD-style frequency dependence too (~±0.5 dB
//         at HF) that Maekawa-baseline doesn't capture. Docs-only.

import { airAbsorptionDbPerM } from './air-absorption.js';
import { PHYSICS_P1_5_ENABLED } from './feature-flags.js';
import { extractOverheadReflectors } from './overhead-geometry.js';

// Speed of sound at temperature T (°C). Inlined to avoid a circular
// import with spl-calculator.js (which itself imports diffraction
// from commit (c) onwards). Same formula as spl-calculator's
// speedOfSound — keep in sync.
const DEFAULT_TEMPERATURE_C = 20;
function speedOfSound(T_C = DEFAULT_TEMPERATURE_C) {
  return 331.3 * Math.sqrt(1 + T_C / 273.15);
}

// Hard upper clamp on diffraction insertion loss. Maekawa measurements
// asymptote at ~24 dB regardless of N — creeping waves over the edge
// always contribute. ISO 9613-2 §7.4 caps the same value.
export const MAEKAWA_IL_MAX_DB = 24;

// Lower floor when N → 0+ (formula evaluates to exactly 5 at N=0).
// Below the lit-zone (δ < −λ/8) the IL is zero, not 5; the linear
// handoff bridges the two regimes smoothly.
export const MAEKAWA_IL_GRAZE_DB = 5;

// Maekawa-Tachibana IL at one band. `delta_m` may be negative (lit zone).
export function maekawaIL(delta_m, lambda_m) {
  if (!Number.isFinite(delta_m) || !Number.isFinite(lambda_m) || lambda_m <= 0) return 0;
  const grazeWindow = lambda_m / 8;   // smoothing window into the lit zone
  if (delta_m <= -grazeWindow) return 0;
  if (delta_m <= 0) {
    // Linear 0 → 5 dB across the grazing handoff window.
    const t = (delta_m + grazeWindow) / grazeWindow;   // 0 at deep edge, 1 at boundary
    return MAEKAWA_IL_GRAZE_DB * t;
  }
  const N = 2 * delta_m / lambda_m;
  const x = Math.sqrt(2 * Math.PI * N);
  const il = MAEKAWA_IL_GRAZE_DB + 20 * Math.log10(x / Math.tanh(x));
  return Math.min(MAEKAWA_IL_MAX_DB, il);
}

// Maekawa-Tachibana IL with a thick-barrier correction. Phase 5 Step 6
// (Dr. Chen spec + sign-off 2026-05-23).
//
//   IL_thick = IL_M(δ, λ) + max(0, 10·log10(w/λ))
//
// The first term is the standard single-edge Maekawa IL over the
// barrier's signed path-difference δ. The second is the "above-barrier
// propagation penalty" — additional loss as the diffracted wave traverses
// the top of a finite-thickness barrier. The clamp `max(0, ...)` enforces
// the formula's only-positive-when-w>λ behaviour; the term is zero by
// design at wavelengths much longer than the barrier thickness (the
// barrier is "thin" relative to the wavelength).
//
// Why NOT the Kurze-Anderson sum-form `IL_M(δ1) + IL_M(δ2) + 10·log10(w/λ)`:
// at small w the two edges are correlated (δ1 ≈ δ2 ≈ δ_single), and the
// sum-form double-counts the single-edge IL — over-predicts by up to
// 17 dB at the w → 0 limit. Per Dr. Chen 2026-05-23 the WallLAB formula
// stays on Maekawa single-edge + thickness bonus, continuous everywhere,
// reduces cleanly at w → 0. Cites Maekawa 1968 + ISO 9613-2 §7.4 (NOT
// Kurze-Anderson 1971 sum-form).
//
// Bonus values at w = 0.25 m (typical concrete partition):
//   125–500 Hz (λ > 0.69 m): 0 dB (clamped, w < λ).
//   1 kHz   (λ = 0.343 m, w/λ = 0.73): 0 dB (clamped).
//   2 kHz   (λ = 0.172 m, w/λ = 1.46): +1.6 dB.
//   4 kHz   (λ = 0.086 m, w/λ = 2.91): +4.6 dB.
//   8 kHz   (λ = 0.043 m, w/λ = 5.83): +7.7 dB.
// A-weighted broadband effect on typical geometries: ~+0.6 dB total.
//
// Total IL is NOT capped at MAEKAWA_IL_MAX_DB — Maekawa caps the
// SINGLE-EDGE term; the thickness bonus stacks on top for genuinely
// wide barriers (Dr. Chen 2026-05-23). A 2 m thick concrete wall can
// legitimately predict > 30 dB IL via this stack.
export function thickBarrierIL(delta_m, lambda_m, width_m) {
  const il_base = maekawaIL(delta_m, lambda_m);
  if (!Number.isFinite(width_m) || width_m <= 0) return il_base;
  if (!Number.isFinite(lambda_m) || lambda_m <= 0) return il_base;
  const bonus = Math.max(0, 10 * Math.log10(width_m / lambda_m));
  return il_base + bonus;
}

// SIGNED 2D over-a-single-thin-screen path-length difference δ (metres), for
// the WallLAB over-wall diffraction demo. Vertical plane only:
//   source   S = (0, sourceH)
//   screen top T = (sourceToBarrier, barrierH)
//   receiver R = (sourceToBarrier + barrierToReceiver, receiverH)
//
//   detour = (|S→T| + |T→R|) − |S→R|        always ≥ 0 (triangle inequality)
//
// The triangle inequality can't sign the result, so we sign it by whether the
// straight S→R sightline passes BELOW the screen top at the screen's
// horizontal position (receiver in shadow → +δ) or ABOVE it (lit → −δ).
// maekawaIL() then reads +δ as insertion loss and −δ (below the graze window)
// as the lit zone (0 dB). This is exactly the surau geometry: a source
// mounted ABOVE a wall has its sightline clear the top → −δ → ~no loss →
// sound "leaks over". Standard barrier model; ISO 9613-2 §7.4 / Maekawa 1968.
export function overBarrierPathDifference({ sourceH, barrierH, sourceToBarrier, barrierToReceiver, receiverH }) {
  const d1 = Math.max(0, sourceToBarrier);
  const d2 = Math.max(0, barrierToReceiver);
  const dST = Math.hypot(d1, barrierH - sourceH);
  const dTR = Math.hypot(d2, receiverH - barrierH);
  const dSR = Math.hypot(d1 + d2, receiverH - sourceH);
  const detour = (dST + dTR) - dSR;
  const totalD = d1 + d2;
  // Height of the straight sightline where it crosses the screen plane.
  const hLine = totalD > 0 ? sourceH + (receiverH - sourceH) * (d1 / totalD) : Math.max(sourceH, receiverH);
  const shadowed = barrierH > hLine;
  return shadowed ? detour : -detour;
}

// Pierce-Hadden wedge correction on top of Maekawa for an outdoor
// building corner (Dr. Chen Tier 1a commit (e) spec, derived from
// Pierce *Acoustics* §9.5 collapsed to the right-angle case).
//
// Formula:
//   ΔIL_wedge(β_solid) = 10·log10(2π / (2π − β_solid))
//
// Sample values:
//   β = 0       → ΔIL = 0   dB (thin knife edge — returns Maekawa unchanged)
//   β = π/2     → ΔIL ≈ +1.25 dB (90° outdoor building corner — typical case)
//   β = π       → ΔIL ≈ +3.01 dB
//   β = 3π/2    → ΔIL ≈ +6.02 dB (270° re-entrant indoor corner — rare)
//   β → 2π      → ΔIL → ∞   (closed solid; defensive clamp at 2π − 0.01)
//
// The correction is scaled by `base_il / GRAZE_DB` through the smooth
// handoff zone so the corner-shadow boundary doesn't show a visible
// step at δ=0. Above the graze plateau (base_il ≥ 5) the full
// correction is applied.
export function wedgeIL(delta_m, lambda_m, beta_solid_rad) {
  const base = maekawaIL(delta_m, lambda_m);
  if (base <= 0) return 0;
  if (!Number.isFinite(beta_solid_rad) || beta_solid_rad <= 0) return base;
  // β_solid → 2π is a closed solid with no edge; clamp to 2π − 0.01 rad
  // to keep the formula finite if a malformed corner ever reaches here.
  const beta = Math.min(beta_solid_rad, 2 * Math.PI - 0.01);
  const dIL = 10 * Math.log10(2 * Math.PI / (2 * Math.PI - beta));
  const scale = Math.min(1, base / MAEKAWA_IL_GRAZE_DB);
  return Math.min(MAEKAWA_IL_MAX_DB, base + dIL * scale);
}

// Closest path-via-edge point on a finite edge segment, by image-source
// method (Fermat's principle). Returns { E, detour, delta } where
// `detour = |S→E| + |E→R|` and `delta = detour − |S→R|`. The optimum
// edge parameter `t_opt = (s∥·r_perp + r∥·s_perp) / (s_perp + r_perp)`
// is clamped to the finite segment [0, edgeLength].
export function diffractionPointOnEdge(S, R, E1, E2) {
  const ex = E2.x - E1.x, ey = E2.y - E1.y, ez = E2.z - E1.z;
  const elen = Math.hypot(ex, ey, ez);
  if (elen < 1e-9) return null;
  const ux = ex / elen, uy = ey / elen, uz = ez / elen;

  const sToE1 = { x: S.x - E1.x, y: S.y - E1.y, z: S.z - E1.z };
  const rToE1 = { x: R.x - E1.x, y: R.y - E1.y, z: R.z - E1.z };
  const sPar = sToE1.x * ux + sToE1.y * uy + sToE1.z * uz;
  const rPar = rToE1.x * ux + rToE1.y * uy + rToE1.z * uz;

  const sPerpVec = { x: sToE1.x - sPar * ux, y: sToE1.y - sPar * uy, z: sToE1.z - sPar * uz };
  const rPerpVec = { x: rToE1.x - rPar * ux, y: rToE1.y - rPar * uy, z: rToE1.z - rPar * uz };
  const sPerp = Math.hypot(sPerpVec.x, sPerpVec.y, sPerpVec.z);
  const rPerp = Math.hypot(rPerpVec.x, rPerpVec.y, rPerpVec.z);

  const denom = sPerp + rPerp;
  // Degenerate (both points on the edge line): pick the midpoint.
  const tOpt = denom > 1e-9 ? (sPar * rPerp + rPar * sPerp) / denom : 0.5 * elen;
  const tClamped = Math.max(0, Math.min(elen, tOpt));
  const E = {
    x: E1.x + tClamped * ux,
    y: E1.y + tClamped * uy,
    z: E1.z + tClamped * uz,
  };
  const dSE = Math.hypot(E.x - S.x, E.y - S.y, E.z - S.z);
  const dER = Math.hypot(E.x - R.x, E.y - R.y, E.z - R.z);
  const dSR = Math.hypot(R.x - S.x, R.y - S.y, R.z - S.z);
  return { E, detour: dSE + dER, delta: (dSE + dER) - dSR };
}

// Enumerate the free edges of a single wall — those that aren't shared
// with an adjacent wall in the same polygon ring. For a rectangular
// room, every wall's vertical edges are SHARED with the adjacent walls
// (corners), so only the top horizontal edge contributes. For
// standaloneEnclosure polygons with re-entrant corners or for the open
// ends of a curved arcade, vertical edges may be free.
//
// Tier 1a scope: only top + vertical side edges. Bottom edges (raised
// enclosures with elev_m > 0) are P12.
function enumerateFreeEdges(wall, room) {
  // Always emit all 3 diffraction edges (top + 2 verticals) per ISO 9613-2
  // §7.4. Each vertical edge IS a free diffraction edge — the fact that
  // it's shared with an adjacent wall in a rectangular room doesn't make
  // it disappear acoustically; it just means TWO walls in the iteration
  // produce the SAME edge, which the caller dedupes via canonical
  // edge-key Set (Dr. Chen Tier 1a commit (h) spec, section A.2).
  return [
    {
      id: 'top',
      e1: { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m + wall.height_m },
      e2: { x: wall.v2.x, y: wall.v2.y, z: wall.elev_m + wall.height_m },
    },
    {
      id: 'left',
      e1: { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m },
      e2: { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m + wall.height_m },
    },
    {
      id: 'right',
      e1: { x: wall.v2.x, y: wall.v2.y, z: wall.elev_m },
      e2: { x: wall.v2.x, y: wall.v2.y, z: wall.elev_m + wall.height_m },
    },
  ];
}

// Canonical edge key for dedupe — direction-agnostic so the NE vertical
// edge (shared between wall_north and wall_east) produces the same key
// from both walls' enumeration passes. Round to 3 decimal places so
// floating-point endpoint computation jitter doesn't break dedupe.
function edgeKey(e1, e2) {
  const r = (v) => Math.round(v * 1000) / 1000;
  const a = `${r(e1.x)},${r(e1.y)},${r(e1.z)}`;
  const b = `${r(e2.x)},${r(e2.y)},${r(e2.z)}`;
  // Sort endpoints so {e1,e2} and {e2,e1} produce identical keys.
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Ground-reflected diffraction path. Mirror the source through the
// ground plane (z=0 by default), recompute the Fermat optimum for the
// image source, apply Maekawa IL on the image path, attenuate by
// (1 - G) ground absorption factor.
//
// G ∈ [0, 1]: 0 = hard reflective (concrete/asphalt), 1 = fully
// absorptive (snow). Per ISO 9613-2 §7.3.1 single-value engineering
// approximation. Per-band G is P17 deferred.
//
// Returns { detour_m, delta_m, il_db, attenuationFactor } where
// `attenuationFactor` ∈ [0, 1] is the energy multiplier (1 = hard ground
// = full reflection, 0 = full absorption = no contribution). Caller
// multiplies the path's power by this before energy-summing.
function groundReflectedDiffraction(src, listener, edge, lambda_m, groundPlaneZ, groundG) {
  // G ∈ [0, 1]: 0 = hard reflective (full image-source contribution),
  // 1 = fully absorbent (no contribution). Clamp + compute below.
  // Mirror source through ground plane: z' = 2·groundPlaneZ - z.
  const srcImage = {
    x: src.x,
    y: src.y,
    z: 2 * groundPlaneZ - src.z,
  };
  const opt = diffractionPointOnEdge(srcImage, listener, edge.e1, edge.e2);
  if (!opt) return null;
  const il_db = maekawaIL(opt.delta, lambda_m);
  if (il_db <= 0) return null;
  // Hard ground (G=0) → attenuation = 1 → full reflection.
  // Soft ground (G=1) → attenuation = 0 → no ground contribution.
  const G = Math.max(0, Math.min(1, groundG ?? 0));
  const attenuationFactor = 1 - G;
  return {
    detour_m: opt.detour,
    delta_m: opt.delta,
    il_db,
    attenuationFactor,
  };
}

// Phase 8 Step 5 — resolve an arcade / portico roof crossing back to
// its overhead polygon (4 corners at z=z_top). The wallId pattern is
// `${kind}_${side}_ceiling` per wall-path.js's testHorizontalPlanes
// idPrefix (kind from extractOverheadReflectors: 'arcade_roof' or
// 'portico_roof'; side from sideSpec: 'south'/'east'/'west'/'north').
// Returns null when no match — caller falls back to the standard wall
// geometry path.
function resolveOverheadGeometry(room, wallId) {
  const match = /^(arcade_roof|portico_roof)_([a-z]+)_ceiling$/.exec(wallId);
  if (!match) return null;
  const kind = match[1];
  const side = match[2];
  const reflectors = extractOverheadReflectors(room);
  if (!Array.isArray(reflectors)) return null;
  const refl = reflectors.find(r => r.kind === kind && r.side === side);
  return refl || null;   // { vertices, z_top, materialId, kind, side }
}

// Enumerate the perimeter edges of a horizontal roof polygon. Each
// edge runs at z=z_top (so they're horizontal lines like the wall
// 'top' edges; the vertical-edge IL floor does NOT apply). Sound
// going around an arcade's OUTER edge (the side facing away from
// the building) bypasses the through-roof transmission path.
//
// SKIP the INNER edge — the one adjacent to the building wall — to
// avoid double-counting the eave with the building wall's TOP edge
// (they're the same physical line, just z=4.4 (arcade) vs z=4.5
// (wall top)). User-reported 2026-05-24 follow-up: listener INSIDE
// the building near the west wall read 90+ dB because BOTH the
// arcade-roof-inner-edge AND the building-wall-top-edge contributed
// independently to the same physical eave bypass path.
//
// Inner-edge detection: for the surau arcade convention (overhead-
// geometry.js arcade sideSpec), the INNER edge is the one whose
// endpoints both lie on the building wall corresponding to the
// arcade's `side`:
//   side='south' → inner edge at y=0
//   side='north' → inner edge at y=room.depth_m
//   side='east'  → inner edge at x=room.width_m
//   side='west'  → inner edge at x=0
function enumerateRoofPerimeterEdges(refl, room) {
  const v = refl.vertices;
  const z = refl.z_top;
  const out = [];
  // Skip-coord: which axis-aligned coordinate defines the inner edge.
  // For an arcade_roof, refl.side names which building wall it abuts.
  let skipAxis = null;
  let skipValue = null;
  if (refl.kind === 'arcade_roof' && room) {
    const W = Number(room.width_m) || 0;
    const D = Number(room.depth_m) || 0;
    if (refl.side === 'south')      { skipAxis = 'y'; skipValue = 0; }
    else if (refl.side === 'north') { skipAxis = 'y'; skipValue = D; }
    else if (refl.side === 'east')  { skipAxis = 'x'; skipValue = W; }
    else if (refl.side === 'west')  { skipAxis = 'x'; skipValue = 0; }
  }
  const COINCIDE_TOL_M = 0.05;
  for (let i = 0; i < v.length; i++) {
    const v1 = v[i];
    const v2 = v[(i + 1) % v.length];
    // Skip the inner edge — both endpoints on the building wall line.
    if (skipAxis && skipValue !== null) {
      const c1 = skipAxis === 'x' ? v1.x : v1.y;
      const c2 = skipAxis === 'x' ? v2.x : v2.y;
      if (Math.abs(c1 - skipValue) < COINCIDE_TOL_M
        && Math.abs(c2 - skipValue) < COINCIDE_TOL_M) {
        continue;
      }
    }
    out.push({
      id: `roof_perim_${i}`,
      e1: { x: v1.x, y: v1.y, z },
      e2: { x: v2.x, y: v2.y, z },
    });
  }
  return out;
}

// Resolve a wallId (from wallsCrossedByPath) back to its geometric
// definition. Mirrors the canonical wallSpecs ordering in wall-path.js.
function resolveWallGeometry(room, wallId) {
  if (!room) return null;
  const W = Number(room.width_m) || 0;
  const D = Number(room.depth_m) || 0;
  const H = Number(room.height_m) || 0;
  // Parent rectangular walls follow the same (v1, v2) order as
  // wall-path.js rectangularWalls + triangulate-scene.js wallSpecs.
  // Two are deliberately reversed from naive CCW; don't "fix" without
  // also updating wall-path.js.
  if (wallId === 'parent_wall_north') return { v1: { x: W, y: 0 }, v2: { x: 0, y: 0 }, elev_m: 0, height_m: H };
  if (wallId === 'parent_wall_south') return { v1: { x: 0, y: D }, v2: { x: W, y: D }, elev_m: 0, height_m: H };
  if (wallId === 'parent_wall_east')  return { v1: { x: W, y: 0 }, v2: { x: W, y: D }, elev_m: 0, height_m: H };
  if (wallId === 'parent_wall_west')  return { v1: { x: 0, y: D }, v2: { x: 0, y: 0 }, elev_m: 0, height_m: H };
  // Parent floor / ceiling: diffraction not applied for the building's
  // own ceiling — its perimeter edges coincide with the wall TOP edges
  // (the eave line), which are already integrated via the wall-side
  // enumerateFreeEdges path (dedupe catches the duplicate).
  if (wallId === 'parent_floor' || wallId === 'parent_ceiling') return null;
  // Phase 8 Step 5 (Dr. Chen audit 2026-05-24): arcade / portico roof
  // crossings get a SEPARATE roof-polygon geometry resolved below via
  // resolveOverheadGeometry, NOT a wall-style v1/v2. Return null here
  // so the caller falls through to the overhead-geometry branch.
  if (wallId.startsWith('arcade_roof_') || wallId.startsWith('portico_roof_')) return null;
  // Polygon edge: parent_edge_<i>
  const polyMatch = /^parent_edge_(\d+)$/.exec(wallId);
  if (polyMatch && Array.isArray(room.custom_vertices)) {
    const i = Number(polyMatch[1]);
    const v = room.custom_vertices;
    if (v[i] && v[(i + 1) % v.length]) {
      return { v1: v[i], v2: v[(i + 1) % v.length], elev_m: 0, height_m: H };
    }
  }
  // Standalone enclosure edge: enc<ei>_edge_<i>
  const encMatch = /^enc(\d+)_edge_(\d+)$/.exec(wallId);
  if (encMatch && Array.isArray(room.standaloneEnclosures)) {
    const enc = room.standaloneEnclosures[Number(encMatch[1])];
    const i = Number(encMatch[2]);
    if (enc?.polygon && enc.polygon[i] && enc.polygon[(i + 1) % enc.polygon.length]) {
      return {
        v1: enc.polygon[i],
        v2: enc.polygon[(i + 1) % enc.polygon.length],
        elev_m: Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0,
        height_m: Number.isFinite(enc.height_m) ? enc.height_m : 3,
      };
    }
  }
  return null;
}

// Compute total diffracted-path power contribution at the listener
// across every free edge of every wall the direct path crosses.
// Returns { paths: [...], totalPower } where `paths` is the per-edge
// breakdown (for the per-listener breakdown UI) and `totalPower` is
// the energy-summed contribution ready to add to direct+rerad+reverb.
//
// **PER-BAND ONLY.** This function takes a single `freq_hz` and a
// single-band `sourceLpFreeField_db` for THAT band; the `Lp_1m`
// un-spreading at line 386 below depends on the air-absorption term
// being self-consistent with the band's wavelength. Calling with a
// broadband (e.g. A-weighted total) Lp + a single freq silently
// produces wrong dB — no NaN, no error, just a wrong number. Callers
// must loop bands outside this function. (Martina audit 2026-05-23.)
//
// Caller must already have:
//   * wallsCrossed = wallsCrossedByPath(src.position, listener, room)
//   * sourceLpFreeField_db = Lp at the *direct* path (= sens + 10log10(P)
//                            − 20·log10(|S→R|) + directivity_attn + eqGain).
//     This function rescales it to the longer detour path: subtract the
//     extra free-field spread + apply Maekawa IL + air abs on the detour.
//
// When the flag is OFF or wallsCrossed has no solid crossings, returns
// { paths: [], totalPower: 0 } — caller adds zero, behaviour unchanged.
export function computeDiffractionContributions({
  src, listener, room, wallsCrossed, materials, freq_hz,
  sourceLpFreeField_db, temperature_C = DEFAULT_TEMPERATURE_C,
  airAbsorption = true,
  groundG = 0,                  // NEW (h): ground absorption [0,1]; 0 = hard
  groundPlaneZ = 0,             // NEW (h): mirror plane for image source
  // Outdoor mode (Phase 2d) needs the interior→field boundary to be a
  // gradient regardless of the public-deploy PHYSICS_P1_5 flag. An
  // explicit `enable: true` activates this contribution even when the
  // module-level flag is off. When omitted, behaviour is identical to
  // the historical flag-gated path. Indoor public deploys never pass it.
  enable = PHYSICS_P1_5_ENABLED,
}) {
  if (!enable) return { paths: [], totalPower: 0 };
  if (!Array.isArray(wallsCrossed) || wallsCrossed.length === 0) {
    return { paths: [], totalPower: 0 };
  }
  // Guard: skip if every crossing is through an opening — direct path
  // is already unattenuated (TL=0), diffraction would add noise.
  const solid = wallsCrossed.filter(w => !w.throughOpening);
  if (solid.length === 0) return { paths: [], totalPower: 0 };

  const c = speedOfSound(temperature_C);
  const lambda = c / freq_hz;
  // Direct path length, used to convert sourceLpFreeField_db (at distance
  // |S→R|) into Lp at unit distance, then re-spread to the detour length.
  const dx = listener.x - src.position.x;
  const dy = listener.y - src.position.y;
  const dz = listener.z - src.position.z;
  const directLen = Math.max(0.1, Math.hypot(dx, dy, dz));
  // Lp at 1 m (free-field) for this source at this band. We can derive
  // it back from Lp(direct) by undoing the 1/r² + air absorption terms.
  const directAirAbs = airAbsorption ? airAbsorptionDbPerM(freq_hz) * directLen : 0;
  const Lp_1m = sourceLpFreeField_db + 20 * Math.log10(directLen) + directAirAbs;

  // Edge-level dedupe (Dr. Chen (h) spec, section A.2). The NE vertical
  // edge is wall_north's `right` AND wall_east's `left`. Without dedupe
  // we'd integrate the same physical edge twice → +3 dB double-count
  // on every corner-bend contribution. Skip if already integrated.
  const seenEdges = new Set();

  // Phase 8 Step 5 (Dr. Chen audit 2026-05-24): thick-barrier IL floors
  // on building-wall diffraction edges. The Maekawa formula is a
  // KNIFE-EDGE approximation — it assumes zero thickness. For a real
  // concrete or brick wall (typical thickness 100-300 mm), sound
  // bending around the wall's TOP edge or vertical CORNER edge
  // experiences additional viscothermal absorption + mass-loading at
  // the edge that Maekawa under-counts.
  //
  //   VERTICAL_EDGE_IL_FLOOR_DB — applied to `left` / `right` edges of
  //     parent building walls. Original user-reported issue: +11 dB
  //     SW-corner spike (surau exterior heatmap, 2026-05-24) when a
  //     listener just past the building corner saw a low-IL (~5 dB)
  //     vertical-corner contribution.
  //
  //   TOP_EDGE_IL_FLOOR_DB — applied to the `top` edge of parent
  //     building walls ONLY (not standalone barriers, not arcade roof
  //     perimeter edges). Original user-reported issue 2026-05-24
  //     follow-up: listener INSIDE the building near a wall reads
  //     90-100 dB — louder than the outdoor corridor on the other side
  //     of the wall. The Maekawa shadow-boundary IL is tiny (~3-5 dB)
  //     for a listener just behind the wall, so diffraction over the
  //     eave dominates and the wall's transmission loss (53 dB on
  //     concrete) becomes irrelevant. Real thick-walled buildings
  //     don't behave this way; the eave attenuates ~6-10 dB more than
  //     Maekawa predicts for a thick concrete wall.
  //
  //   Both floors are restricted to wallIds starting `parent_wall_` so
  //   they apply only to closed-building rectangles. Standalone
  //   outdoor barriers and custom polygons keep pure Maekawa.
  const VERTICAL_EDGE_IL_FLOOR_DB = 16.0;
  const TOP_EDGE_IL_FLOOR_DB = 16.0;

  let totalPower = 0;
  const paths = [];
  for (const crossing of solid) {
    // Phase 8 Step 5 — arcade / portico roof crossings get their own
    // enumeration path (4 horizontal perimeter edges at z=roof_height).
    // Sound bending around the OUTER edge of an arcade roof is a real
    // diffraction path for paths that transit through the roof from
    // above-roof sources to below-roof listeners (the user's surau
    // azan-horn case at z=7 → arcade corridor at z=1.7).
    let edges;
    let isOverheadEdge = false;
    const overheadRefl = resolveOverheadGeometry(room, crossing.wallId);
    if (overheadRefl) {
      edges = enumerateRoofPerimeterEdges(overheadRefl, room);
      isOverheadEdge = true;
    } else {
      const wall = resolveWallGeometry(room, crossing.wallId);
      if (!wall) continue;
      edges = enumerateFreeEdges(wall, room);
    }
    for (const edge of edges) {
      const key = edgeKey(edge.e1, edge.e2);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      const opt = diffractionPointOnEdge(src.position, listener, edge.e1, edge.e2);
      if (!opt) continue;
      let il_db = maekawaIL(opt.delta, lambda);
      if (il_db <= 0) continue;     // lit zone for this edge — no contribution
      // Thick-barrier floors per edge type, applied to parent building
      // walls AND to arcade / portico roof perimeter edges. Both are
      // thick concrete surfaces in real surau-style construction; the
      // knife-edge Maekawa formula under-counts the additional edge
      // absorption. Standalone barriers + custom polygons remain at
      // pure Maekawa.
      //
      // Arcade roof INNER perimeter edge (adjacent to the building
      // wall) is essentially the SAME physical eave as the building
      // wall's TOP edge — both get the TOP-edge floor so the
      // duplicate contributions cap at the same level, preventing
      // double-counted eave concentration that pushed interior cells
      // to 90+ dB pre-fix (user-reported 2026-05-24 follow-up).
      const isParentBuildingWall = crossing.wallId.startsWith('parent_wall_');
      const isOverheadRoof = isOverheadEdge;
      if (isParentBuildingWall) {
        if ((edge.id === 'left' || edge.id === 'right') && il_db < VERTICAL_EDGE_IL_FLOOR_DB) {
          il_db = VERTICAL_EDGE_IL_FLOOR_DB;
        } else if (edge.id === 'top' && il_db < TOP_EDGE_IL_FLOOR_DB) {
          il_db = TOP_EDGE_IL_FLOOR_DB;
        }
      } else if (isOverheadRoof) {
        // All 4 arcade/portico roof perimeter edges are horizontal
        // and thick-concrete-edge in practice; use the top-edge floor.
        if (il_db < TOP_EDGE_IL_FLOOR_DB) il_db = TOP_EDGE_IL_FLOOR_DB;
      }
      // Free-field at the detour length, plus IL, plus air abs on detour.
      const detourAirAbs = airAbsorption ? airAbsorptionDbPerM(freq_hz) * opt.detour : 0;
      const Lp_detour = Lp_1m - 20 * Math.log10(opt.detour) - detourAirAbs - il_db;
      if (Number.isFinite(Lp_detour)) {
        const power = Math.pow(10, Lp_detour / 10);
        totalPower += power;
        paths.push({
          wallId: crossing.wallId,
          edgeId: edge.id,
          pathType: 'direct',
          delta_m: opt.delta,
          detour_m: opt.detour,
          il_db,
          spl_db: Lp_detour,
        });
      }
      // Ground-reflected diffraction path (ISO 9613-2 §7.3 + §7.4).
      // Image-source mirror through groundPlaneZ; same Maekawa formula
      // on the imaged geometry; attenuated by (1 - G). For hard ground
      // (G=0) this doubles the diffracted contribution → +3.01 dB lift
      // in symmetric geometries. Curves the shadow boundary.
      const reflected = groundReflectedDiffraction(
        src.position, listener, edge, lambda, groundPlaneZ, groundG,
      );
      if (reflected && reflected.attenuationFactor > 0) {
        let il_refl = reflected.il_db;
        const isParentBuildingWallRefl = crossing.wallId.startsWith('parent_wall_');
        if (isParentBuildingWallRefl) {
          if ((edge.id === 'left' || edge.id === 'right') && il_refl < VERTICAL_EDGE_IL_FLOOR_DB) {
            il_refl = VERTICAL_EDGE_IL_FLOOR_DB;
          } else if (edge.id === 'top' && il_refl < TOP_EDGE_IL_FLOOR_DB) {
            il_refl = TOP_EDGE_IL_FLOOR_DB;
          }
        } else if (isOverheadEdge && il_refl < TOP_EDGE_IL_FLOOR_DB) {
          il_refl = TOP_EDGE_IL_FLOOR_DB;
        }
        const reflectedAirAbs = airAbsorption ? airAbsorptionDbPerM(freq_hz) * reflected.detour_m : 0;
        const Lp_reflected = Lp_1m - 20 * Math.log10(reflected.detour_m) - reflectedAirAbs - il_refl;
        if (Number.isFinite(Lp_reflected)) {
          const power = Math.pow(10, Lp_reflected / 10) * reflected.attenuationFactor;
          totalPower += power;
          paths.push({
            wallId: crossing.wallId,
            edgeId: edge.id,
            pathType: 'ground',
            delta_m: reflected.delta_m,
            detour_m: reflected.detour_m,
            il_db: il_refl,
            spl_db: Lp_reflected + 10 * Math.log10(reflected.attenuationFactor),
          });
        }
      }
    }
  }
  return { paths, totalPower };
}

// ============================================================================
// Wedge / vertical-corner diffraction (Tier 1a commit (e) — P9 fix)
// ============================================================================
//
// Maekawa-Tachibana single-edge IL handles paths bending over the TOP of a
// wall. Real buildings ALSO let sound bend around the VERTICAL corners
// where two walls meet. For a rectangular building these are right-angle
// (90° exterior) wedges. The Pierce-Hadden correction adds ~+1.25 dB IL
// on top of the Maekawa base — small in magnitude but visually decisive:
// it smooths the ~10 dB shadow-boundary step at every corner into a
// soft 2-4 dB gradient (the artifact the user spotted on the live page).

// Enumerate the outdoor vertical corner wedges of `room`. Each corner
// returns its world position, the two wall faces meeting there, the
// vertical edge endpoints (for the Fermat optimizer), and the solid-
// angle β occupied by the building material at this corner.
//
// Tier 1a scope: rectangular rooms only (4 corners, β = π/2 each).
// Polygon-room corners (P14) and standaloneEnclosure corners (P15)
// return empty arrays for now and are documented in the header.
export function enumerateRoomCorners(room) {
  if (!room) return [];
  const shape = room.shape;
  const isRect = !shape || shape === 'rectangular';
  if (!isRect) return [];   // P14 / P15 deferred
  const W = Number(room.width_m) || 0;
  const D = Number(room.depth_m) || 0;
  const H = Number(room.height_m) || 0;
  if (W <= 0 || D <= 0 || H <= 0) return [];
  const halfPi = Math.PI / 2;
  return [
    { id: 'corner_NW', x: 0, y: 0,
      faces: ['parent_wall_north', 'parent_wall_west'],
      edge_bottom: { x: 0, y: 0, z: 0 },
      edge_top:    { x: 0, y: 0, z: H },
      beta_solid: halfPi },
    { id: 'corner_NE', x: W, y: 0,
      faces: ['parent_wall_north', 'parent_wall_east'],
      edge_bottom: { x: W, y: 0, z: 0 },
      edge_top:    { x: W, y: 0, z: H },
      beta_solid: halfPi },
    { id: 'corner_SE', x: W, y: D,
      faces: ['parent_wall_south', 'parent_wall_east'],
      edge_bottom: { x: W, y: D, z: 0 },
      edge_top:    { x: W, y: D, z: H },
      beta_solid: halfPi },
    { id: 'corner_SW', x: 0, y: D,
      faces: ['parent_wall_south', 'parent_wall_west'],
      edge_bottom: { x: 0, y: D, z: 0 },
      edge_top:    { x: 0, y: D, z: H },
      beta_solid: halfPi },
  ];
}

// Signed perpendicular distance from `point` to the infinite line through
// `(v1, v2)` in the XY plane. Sign follows the standard 2D cross product
// convention: positive when `point` lies to the LEFT of the directed line
// v1 → v2. For the canonical wall_<side> orientations this puts the room
// interior on the +Z-cross side; we don't need to know which side is
// "inside" — we only need to compare two signs to test if S and R are
// on opposite sides of the same face.
function signedDistanceToLine2D(point, v1, v2) {
  const ex = v2.x - v1.x, ey = v2.y - v1.y;
  const px = point.x - v1.x, py = point.y - v1.y;
  return ex * py - ey * px;
}

// Resolve a wall id to its (v1, v2) endpoints. Cheap helper for the
// shadow-path gate — we don't need the full wall geometry, just the
// 2D footprint line.
function wallFootprintLine(wallId, room) {
  const w = resolveWallGeometry(room, wallId);
  if (!w) return null;
  return { v1: w.v1, v2: w.v2 };
}

// Does the corner's wedge actually shadow the listener from the source?
// The two faces meeting at the corner define two half-planes; sound can
// reach a receiver from the source without diffracting around the corner
// IFF the receiver is on the source's side of BOTH faces (a lit zone).
// If the receiver is on the opposite side of AT LEAST ONE face, the
// corner's wedge contributes (case 2 single-face shadow / case 3 deep
// shadow). Tier 1a uses signed-distance in the wall's 2D plane only —
// vertical containment is enforced by `diffractionPointOnEdge`'s
// segment clamp downstream.
export function cornerIsInShadowPath(corner, src, listener, room) {
  if (!corner || !room) return false;
  const lineA = wallFootprintLine(corner.faces[0], room);
  const lineB = wallFootprintLine(corner.faces[1], room);
  if (!lineA || !lineB) return false;
  const sideA_S = signedDistanceToLine2D(src,      lineA.v1, lineA.v2);
  const sideA_R = signedDistanceToLine2D(listener, lineA.v1, lineA.v2);
  const sideB_S = signedDistanceToLine2D(src,      lineB.v1, lineB.v2);
  const sideB_R = signedDistanceToLine2D(listener, lineB.v1, lineB.v2);
  const crossedA = (sideA_S * sideA_R) < 0;
  const crossedB = (sideB_S * sideB_R) < 0;
  // No-shadow lit zone: both faces have R on the same side as S.
  if (!crossedA && !crossedB) return false;
  // Either single-face shadow (case 2 — the smoothing case) or deep
  // shadow (case 3 — small contribution but still nonzero). Include both.
  return true;
}

// @deprecated since Tier 1a commit (h). The +1.25 dB Pierce-Hadden wedge
// correction this function applied has been REPLACED by full multi-path
// Maekawa-applied-to-the-vertical-edge geometry inside
// computeDiffractionContributions (h spec section D — same physics done
// explicitly, no scalar fudge). Keeping function exported but unused so
// commit (h) bisects cleanly; deletion lands in cleanup commit (i).
// Do NOT add new call sites.
//
// (Original docstring) Compute total wedge-diffracted power contribution
// at the listener across every shadowing rectangular corner of `room`.
// Returns { paths: [...], totalPower } parallel to computeDiffractionContributions.
// Caller energy-sums alongside the existing top-edge diffraction + direct
// (through-wall TL) + re-radiation contributions.
//
// Early-returns zero contribution when flag is off, when the room has no
// rectangular corners (P14/P15 deferred shapes), or when no corner gates
// in the shadow test.
export function computeCornerDiffractionContributions({
  src, listener, room, materials, freq_hz,
  sourceLpFreeField_db, temperature_C = DEFAULT_TEMPERATURE_C,
  airAbsorption = true,
}) {
  if (!PHYSICS_P1_5_ENABLED) return { paths: [], totalPower: 0 };
  if (!room || !src?.position || !listener) return { paths: [], totalPower: 0 };
  const corners = enumerateRoomCorners(room);
  if (corners.length === 0) return { paths: [], totalPower: 0 };

  const c = speedOfSound(temperature_C);
  const lambda = c / freq_hz;
  const dx = listener.x - src.position.x;
  const dy = listener.y - src.position.y;
  const dz = listener.z - src.position.z;
  const directLen = Math.max(0.1, Math.hypot(dx, dy, dz));
  const directAirAbs = airAbsorption ? airAbsorptionDbPerM(freq_hz) * directLen : 0;
  // Reconstruct Lp at 1 m from the direct-path Lp (caller passes Lp at
  // direct length WITHOUT wall TL applied; the corner-bend path bypasses
  // the wall entirely so we don't reapply TL).
  const Lp_1m = sourceLpFreeField_db + 20 * Math.log10(directLen) + directAirAbs;

  let totalPower = 0;
  const paths = [];
  for (const corner of corners) {
    if (!cornerIsInShadowPath(corner, src.position, listener, room)) continue;
    const opt = diffractionPointOnEdge(src.position, listener, corner.edge_bottom, corner.edge_top);
    if (!opt) continue;
    const il_db = wedgeIL(opt.delta, lambda, corner.beta_solid);
    if (il_db <= 0) continue;
    const detourAirAbs = airAbsorption ? airAbsorptionDbPerM(freq_hz) * opt.detour : 0;
    const Lp_detour = Lp_1m - 20 * Math.log10(opt.detour) - detourAirAbs - il_db;
    if (!Number.isFinite(Lp_detour)) continue;
    totalPower += Math.pow(10, Lp_detour / 10);
    paths.push({
      cornerId: corner.id,
      delta_m: opt.delta,
      detour_m: opt.detour,
      il_db,
      spl_db: Lp_detour,
    });
  }
  return { paths, totalPower };
}

// Test-only export so the unit test can verify enumerateFreeEdges
// behaviour without exporting it to the public API surface.
export const _testing = { enumerateFreeEdges, resolveWallGeometry, signedDistanceToLine2D };

// Public re-export — reradiation.js needs the same wall-id → geometry
// resolution, no point duplicating it in two modules.
export { resolveWallGeometry };
