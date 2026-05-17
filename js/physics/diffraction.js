// js/physics/diffraction.js
//
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
//   P9  — Single-edge diffraction only; no wedge diffraction at
//         outdoor wall-wall corners (Pierce §9). Off by ~2-4 dB
//         directly behind a corner.
//   P11 — Diffraction not modelled across coupled-rooms shared walls;
//         interior partitions use through-wall TL only.
//   P12 — Bottom-edge diffraction for raised standaloneEnclosures
//         (elev_m > 0) not enumerated. Top + verticals only.

import { airAbsorptionDbPerM } from './air-absorption.js';
import { PHYSICS_P1_5_ENABLED } from './feature-flags.js';

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
  const edges = [];
  // Top horizontal edge — always free (no roof above an exterior wall).
  edges.push({
    id: 'top',
    e1: { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m + wall.height_m },
    e2: { x: wall.v2.x, y: wall.v2.y, z: wall.elev_m + wall.height_m },
  });
  // Vertical sides — only free if no other wall in the polygon shares
  // the endpoint. For rectangular rooms this is never true (all 4
  // corners are shared). For non-rectangular shapes we'd need to scan
  // adjacent walls; for Tier 1a we conservatively assume all rectangular
  // verticals are SHARED (so they don't contribute) and emit verticals
  // for non-rectangular shapes (they'll usually contribute correctly,
  // and over-counting by 1 edge is negligible vs missing the top edge).
  const isRect = !room?.shape || room.shape === 'rectangular';
  if (!isRect) {
    edges.push({
      id: 'left',
      e1: { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m },
      e2: { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m + wall.height_m },
    });
    edges.push({
      id: 'right',
      e1: { x: wall.v2.x, y: wall.v2.y, z: wall.elev_m },
      e2: { x: wall.v2.x, y: wall.v2.y, z: wall.elev_m + wall.height_m },
    });
  }
  return edges;
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
  // Floor / ceiling planes — diffraction not applied (you can't diffract
  // around the floor or ceiling within a closed room; they're infinite
  // in horizontal extent for diffraction purposes).
  if (wallId === 'parent_floor' || wallId === 'parent_ceiling') return null;
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
}) {
  if (!PHYSICS_P1_5_ENABLED) return { paths: [], totalPower: 0 };
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

  let totalPower = 0;
  const paths = [];
  for (const crossing of solid) {
    const wall = resolveWallGeometry(room, crossing.wallId);
    if (!wall) continue;
    const edges = enumerateFreeEdges(wall, room);
    for (const edge of edges) {
      const opt = diffractionPointOnEdge(src.position, listener, edge.e1, edge.e2);
      if (!opt) continue;
      const il_db = maekawaIL(opt.delta, lambda);
      if (il_db <= 0) continue;     // lit zone for this edge — no contribution
      // Free-field at the detour length, plus IL, plus air abs on detour.
      const detourAirAbs = airAbsorption ? airAbsorptionDbPerM(freq_hz) * opt.detour : 0;
      const Lp_detour = Lp_1m - 20 * Math.log10(opt.detour) - detourAirAbs - il_db;
      if (!Number.isFinite(Lp_detour)) continue;
      const power = Math.pow(10, Lp_detour / 10);
      totalPower += power;
      paths.push({
        wallId: crossing.wallId,
        edgeId: edge.id,
        delta_m: opt.delta,
        detour_m: opt.detour,
        il_db,
        spl_db: Lp_detour,
      });
    }
  }
  return { paths, totalPower };
}

// Test-only export so the unit test can verify enumerateFreeEdges
// behaviour without exporting it to the public API surface.
export const _testing = { enumerateFreeEdges, resolveWallGeometry };

// Public re-export — reradiation.js needs the same wall-id → geometry
// resolution, no point duplicating it in two modules.
export { resolveWallGeometry };
