// js/physics/exterior-coupling.js  [v=652 — Phase 2 of the indoor exterior-source coupling fix]
//
// EXTERIOR-MOUNTED SOURCE → INTERIOR REVERBERANT-FIELD COUPLING COEFFICIENT
//
// When a loudspeaker is mounted OUTSIDE the building envelope (the canonical
// example: 4× azan horns on the surau minaret gallery, pointing OUT to the
// neighbourhood), the indoor Hopkins-Stryker aggregate must NOT inject the
// horn's full radiated power into the interior reverberant field. Sabine /
// Kuttruff's diffuse-field assumption requires the source to actually be
// excitating the enclosure. An exterior source excites the interior only via
// the fraction of its radiated power that (a) is geometrically incident on
// the building's exterior surfaces and (b) transmits through them.
//
// This module computes that fraction per octave band:
//
//   C_couple_src[k] = 10·log10( Σ_f  F_f(src) · τ_f[k] )      [dB, ≤ 0]
//
// where:
//   • F_f(src)  = fraction of source's TOTAL radiated power incident on
//                 facet f (directivity-weighted view factor, dimensionless,
//                 0..1; summed over all facets ≤ 1).
//   • τ_f[k]    = transmission coefficient of facet f at band k
//                 = 10^(−TL_f[k] / 10); a wall with TL=30 dB has τ=0.001.
//                 Openings are treated as τ = 1 (MVP — see Limitations).
//
// Phase 3 (spl-calculator.js wiring) will consume the per-source per-band
// coefficient and add it to L_w_src[k] before energy-summing into the
// interior reverberant aggregate, restoring Sabine validity.
//
// References:
//   * Kuttruff, Room Acoustics 5th ed. §5.4 (sound transmission through
//     walls; incident-vs-diffuse intensity conversion).
//   * Hopkins, Sound Insulation 2007 §4.3 (transmission coefficient τ
//     and TL definition).
//   * ISO 12354-3:2017 §4.3 (façade-method sound insulation — the
//     "proper" path for re-radiating the opening-leak as a secondary
//     diffuse-field excitation; DEFERRED to v2).
//   * ISO 9613-2:1996 §7 (analogous formulation for outdoor-to-outdoor
//     façade transmission; we apply the same accounting inward).
//
// Pure ES6 module. Node-testable. NO Three.js, NO DOM.
// Style matches js/physics/reradiation.js + js/physics/diffraction.js.
//
// MVP scope (Hannes-confirmed 2026-05-25, user-approved):
//   • Closed walls only. Openings (facet.isOpening === true) contribute as
//     τ = 1 "leak" (the full incident fraction enters the room). This is a
//     slight under-count for openings because the leaked acoustic power is
//     NOT re-distributed as secondary diffuse-field excitation inside the
//     room. For the surau prayer hall (mihrab + entrance, < 5% of envelope
//     area) the under-count is < 1 dB. Big opening cases (~25%+ aperture
//     area) want the ISO 12354-3 §4.3 façade method — see v2 notes below.
//   • Single-centroid facet view-factor (apparent solid angle
//     dΩ_f ≈ A_f · cos(θ_normal_f) / r_f²). Accurate to ~0.5 dB while the
//     facet subtends < 1.5 sr from the source. A source flush against a
//     wall has dΩ → 2π and the centroid approximation breaks — we clamp
//     r to 0.05 m to avoid singularity (boundary loading is a separate
//     Phase 3 concern; see clampDistanceMin_m below).
//   • Directivity weighting from the loudspeaker model's polar grid. If
//     the model lacks polar data the fallback is omnidirectional (Q = 1)
//     with a console.warn (once per session per source ID).
//
// Simplifications logged with the regression-curator (Theo):
//   P17 — Single-centroid view factor (no panel subdivision). Under-states
//         coupling for very large near walls where the centre-of-facet
//         cos-falloff misses the corner-near integral. Bound: < 1 dB
//         when facet subtends < 1.5 sr.
//   P18 — Opening leak not re-distributed as secondary interior diffuse
//         excitation. Under-counts coupling for high-aperture envelopes
//         (> ~15% opening fraction). ISO 12354-3 §4.3 method deferred.
//   P19 — Source-flush-against-wall (r < 0.05 m) clamps distance without
//         applying the 2π / 4π boundary-loading correction. Acceptable
//         while no preset places a source within 5 cm of a wall;
//         documented in this module's clampDistanceMin_m.
//   P20 — Facet normals treated as perfectly planar. Real envelope walls
//         have thickness, soffits, parapets — the geometric F_f ignores
//         them. Bound: < 0.5 dB on rectangular envelopes.

import { interpolateAttenuation } from './loudspeaker.js';

// Canonical octave bands the rest of the engine uses. Matches
// data/materials.json `frequency_bands_hz` (7 entries: 125–8000 Hz) and
// the loudspeaker JSON `frequency_bands_hz` (8 entries: 125–16000 Hz).
//
// SPEC: the task brief asks for 6 bands (125, 250, 500, 1k, 2k, 4k) —
// matching what STIPA / IEC 60268-16 expects for speech-bands. We honour
// that contract here. The 8 kHz material data is available if a caller
// later needs it via computeCouplingCoefficient(src, facets, materials, 6).
export const COUPLING_BANDS_HZ = [125, 250, 500, 1000, 2000, 4000];
export const NUM_BANDS = COUPLING_BANDS_HZ.length;

// Distance floor for the view-factor 1/r² term. The single-centroid
// approximation breaks down as r → 0 (real solid angle goes to 2π for a
// source touching a wall). 5 cm is below any practical mount distance
// while bounding 1/r² explosion. Per P19 above, boundary loading is NOT
// applied here — that's a Phase 3+ concern.
export const CLAMP_DISTANCE_MIN_M = 0.05;

// Set per source-id to avoid spamming the console when the same speaker
// lacks polar data across many facets / bands / frames.
const _warnedMissingPolar = new Set();

// ---------------------------------------------------------------------------
// localAnglesFromSource — body-frame (az, el) of `target` as seen from `src`
//   with the speaker aimed by {yaw, pitch, roll} (degrees, RoomLAB convention:
//   body aim = +Y, +az = speaker right (+X), +el = speaker up (+Z)).
//
// Duplicated from spl-calculator.js::localAngles to keep this module free of
// the spl-calculator dependency (spl-calculator already imports diffraction +
// reradiation; importing this module would not create a cycle today, but the
// duplication is < 30 LOC and isolates the pure module).
// ---------------------------------------------------------------------------
function localAnglesFromSource(srcPos, srcAimDeg, targetPos) {
  const dx = targetPos.x - srcPos.x;
  const dy = targetPos.y - srcPos.y;
  const dz = targetPos.z - srcPos.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-9) return { r: 1e-9, azimuth_deg: 0, elevation_deg: 0 };

  const yaw = (srcAimDeg?.yaw ?? 0) * Math.PI / 180;
  const pitch = (srcAimDeg?.pitch ?? 0) * Math.PI / 180;
  const roll = (srcAimDeg?.roll ?? 0) * Math.PI / 180;

  // Inverse yaw (R_z(+yaw)).
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = dx * cy - dy * sy;
  const y1 = dx * sy + dy * cy;
  const z1 = dz;
  // Inverse pitch (R_x(-pitch)).
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x2 = x1;
  const y2 = y1 * cp + z1 * sp;
  const z2 = -y1 * sp + z1 * cp;
  // Inverse roll (R_y(-roll)).
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const lx = cr * x2 - sr * z2;
  const ly = y2;
  const lz = sr * x2 + cr * z2;

  const horizLocal = Math.sqrt(lx * lx + ly * ly);
  return {
    r,
    azimuth_deg: Math.atan2(lx, ly) * 180 / Math.PI,
    elevation_deg: Math.atan2(lz, horizLocal) * 180 / Math.PI,
  };
}

// ---------------------------------------------------------------------------
// directivityFactorQ — full directivity factor Q(θ,φ,f) at the given
// off-axis (az, el). Used as the multiplier in the per-steradian power
// distribution
//
//   I(θ,φ) = (W_total / 4π) · Q(θ,φ)
//
// where ∫ Q dΩ / 4π = 1 by definition. The factor decomposes as
//
//   Q(θ,φ,f) = Q_DI(f) · D(θ,φ,f) / D_max(f)        (dimensionless)
//
// • Q_DI(f) is the on-axis directivity factor (linear power) =
//   10^(DI(f) / 10). RoomLAB loudspeaker JSON exposes a single
//   `acoustic.directivity_index_db` (frequency-averaged); we use it
//   across all bands. If absent, Q_DI defaults to 1 (omnidirectional).
//   This is a SIMPLIFICATION — real DI(f) varies 0–15 dB across speech
//   bands. Logged as P22 in the simplification backlog.
//
// • D(θ,φ,f) / D_max(f) is the normalised polar pattern, 1 on-axis,
//   < 1 elsewhere. RoomLAB JSON stores it as `directivity.attenuation_db`
//   (dB attenuation from on-axis); linear = 10^(attn_db / 10).
//
// Falls back to Q = 1 (omnidirectional) if polar grid is missing — logs
// ONE console.warn per source-id per session via _warnedMissingPolar.
//
// `srcIdForWarn` is a string for warning de-dup (e.g. the model id); pass
// null to suppress the warning entirely.
//
// Exported as directivityQ_linear for backwards-compat with the test file.
// ---------------------------------------------------------------------------
export function directivityQ_linear(speakerDef, azimuth_deg, elevation_deg, freq_hz, srcIdForWarn = null) {
  // On-axis directivity factor Q_DI from the spec sheet's single DI value.
  // RoomLAB convention: acoustic.directivity_index_db is a single number
  // (typical of free-field tested loudspeakers).
  const DI_db = Number(speakerDef?.acoustic?.directivity_index_db);
  const Q_DI = Number.isFinite(DI_db) ? Math.pow(10, DI_db / 10) : 1;

  const dir = speakerDef?.directivity;
  if (!dir || !dir.attenuation_db) {
    if (srcIdForWarn && !_warnedMissingPolar.has(srcIdForWarn)) {
      _warnedMissingPolar.add(srcIdForWarn);
      console.warn(`[exterior-coupling] source "${srcIdForWarn}" has no polar data — falling back to omnidirectional pattern (D=1). Coupling estimate is on-axis-only; off-axis facets will be over-counted.`);
    }
    return Q_DI;   // No pattern → uniform-direction Q_DI in every direction.
  }
  if (!dir.attenuation_db[String(freq_hz)]) {
    if (srcIdForWarn && !_warnedMissingPolar.has(srcIdForWarn)) {
      _warnedMissingPolar.add(srcIdForWarn);
      console.warn(`[exterior-coupling] source "${srcIdForWarn}" has no polar data at ${freq_hz} Hz — falling back to omnidirectional at this band.`);
    }
    return Q_DI;
  }
  const attn_db = interpolateAttenuation(dir, azimuth_deg, elevation_deg, freq_hz);
  if (!Number.isFinite(attn_db)) return Q_DI;
  const D_linear = Math.pow(10, attn_db / 10);
  return Q_DI * D_linear;
}

// ---------------------------------------------------------------------------
// incidentPowerOnFacet — fraction of `src`'s TOTAL radiated power that is
// incident on `facet` (single-centroid view factor, directivity-weighted).
//
// Pure: depends only on src position + aim + polar data, facet centroid +
// normal + area. Caller computes once per (src, facet, band) triple.
//
// Returns a fraction in [0, 1]. Back-facing facets (centroid behind the
// facet plane relative to source) return 0.
//
// Math (Dr. Chen MVP):
//   ray   = facet.centroid − src.position
//   r     = max(|ray|, CLAMP_DISTANCE_MIN_M)
//   û     = ray / |ray|                          (unit ray, src → centroid)
//   cosθ  = −û · facet.normal                    (positive when the ray
//                                                 hits the OUTWARD face)
//   dΩ    = facet.area · cosθ / r²               (apparent solid angle)
//   Q     = directivityQ_linear(src.aim → centroid, band)
//   P_inc = (W_src · Q / 4π) · dΩ                (power on this facet, W)
//   F     = (Q / 4π) · dΩ                        (fraction of total power)
//
// We return F (the fraction), not absolute power — caller already knows
// W_src and weights with τ at band k.
// ---------------------------------------------------------------------------
export function incidentPowerOnFacet(src, facet, bandIdx) {
  if (!src?.position || !facet?.centroid || !facet?.normal || !Number.isFinite(facet?.area)) {
    return 0;
  }
  if (facet.area <= 0) return 0;

  const rx = facet.centroid.x - src.position.x;
  const ry = facet.centroid.y - src.position.y;
  const rz = facet.centroid.z - src.position.z;
  const rRaw = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const r = Math.max(CLAMP_DISTANCE_MIN_M, rRaw);
  // When src and centroid coincide (rRaw → 0), the unit ray is undefined
  // → use the OUTWARD facet normal as a fallback so cosθ = 1 (P19 clamp:
  // a flush source is treated as illuminating the facet directly; the
  // single-centroid view-factor approximation is breaking down anyway).
  const denom = rRaw > 1e-9 ? rRaw : 1;
  const useFallbackRay = rRaw < 1e-9;

  // Geometric convention: facet.normal points OUTWARD (away from the room
  // interior). The illumination angle θ_normal is between the OUTWARD
  // normal and the REVERSE ray (centroid → source). For an EXTERIOR
  // source hitting the outer face, the forward ray (src → centroid) goes
  // INTO the wall, so û · n_outward < 0 and cosθ = −û · n_outward > 0.
  // Cull when cosθ ≤ 0 (facet is on the far side of the building, or
  // grazing, or the source sits INSIDE the building looking at the
  // wrong-side face — the Phase 1 classifier should already have routed
  // interior sources around this module, but we double-cull as a guard).
  const ux = useFallbackRay ? -facet.normal.x : rx / denom;
  const uy = useFallbackRay ? -facet.normal.y : ry / denom;
  const uz = useFallbackRay ? -facet.normal.z : rz / denom;
  const cosTheta = -(ux * facet.normal.x + uy * facet.normal.y + uz * facet.normal.z);
  if (!Number.isFinite(cosTheta) || cosTheta <= 0) return 0;

  // Apparent solid angle.
  const dOmega = facet.area * cosTheta / (r * r);

  // Directivity weighting: angle from src body-frame to facet centroid.
  const { azimuth_deg, elevation_deg } = localAnglesFromSource(
    src.position, src.aim ?? { yaw: 0, pitch: 0, roll: 0 }, facet.centroid
  );
  const freq_hz = COUPLING_BANDS_HZ[bandIdx];
  const srcIdForWarn = src?.model?.id ?? src?.modelUrl ?? null;
  const Q = directivityQ_linear(src.model, azimuth_deg, elevation_deg, freq_hz, srcIdForWarn);

  // Fraction of TOTAL radiated power on this facet:
  //   F = (Q / 4π) · dΩ            with Q = Q_DI · D(θ,φ)
  //
  // For omni (Q_DI = 1, D = 1) F = dΩ / 4π — the geometric solid-angle
  // fraction. For a directive source, on-axis F scales by Q_DI while
  // off-axis F is suppressed by D(θ,φ); the sphere-integral is
  // ∫ Q dΩ / 4π = 1 by definition.
  //
  // NOTE on Q normalisation: in practice the spec-sheet DI + the polar
  // grid are measured by different methods and may not exactly satisfy
  // the sphere-integral identity. For MVP we don't renormalise; the
  // resulting per-source coupling can drift ± 1–2 dB from the
  // self-consistent value. Logged as P21.
  const F = (Q / (4 * Math.PI)) * dOmega;
  // Numeric clamp — cosθ near 0 + small r can briefly drift F above 1
  // (single-centroid breakdown). 1 means "all power on this one facet",
  // a sentinel for source flush against the wall.
  return Math.max(0, Math.min(1, F));
}

// ---------------------------------------------------------------------------
// computeCouplingCoefficient — C_couple_src[bandIdx] in dB.
//
//   C_couple = 10·log10( Σ_f  F_f · τ_f[band] )
//
// Always returns ≤ 0 (coupling never amplifies). Returns −Infinity if no
// facet contributes (e.g. all back-facing). Caller adds this to L_w_src[k]
// before energy-summing into the interior reverberant aggregate.
//
// Openings (facet.isOpening === true) contribute as τ = 1.
// ---------------------------------------------------------------------------
export function computeCouplingCoefficient(src, facets, materials, bandIdx) {
  if (!Array.isArray(facets) || facets.length === 0) return -Infinity;
  if (bandIdx < 0 || bandIdx >= NUM_BANDS) return -Infinity;

  // Materials lookup needs the band index INTO the materials' band list,
  // which is the 7-band list (125–8000). Our 6-band coupling list shares
  // the lower 6 indices, so bandIdx maps 1:1. Defensive: confirm.
  const matBands = materials?.frequency_bands_hz;
  if (!Array.isArray(matBands) || matBands.length < NUM_BANDS) return -Infinity;
  // Sanity: the first 6 bands of materials must match COUPLING_BANDS_HZ.
  // If a future schema reorders bands this will silently mis-index — guard.
  if (matBands[bandIdx] !== COUPLING_BANDS_HZ[bandIdx]) return -Infinity;

  let sum = 0;
  for (const facet of facets) {
    const F = incidentPowerOnFacet(src, facet, bandIdx);
    if (F <= 0) continue;
    let tau;
    if (facet.isOpening) {
      // MVP: open aperture leaks at τ=1 (full incident power enters).
      // Re-distribution as secondary diffuse excitation is DEFERRED (P18).
      tau = 1;
    } else {
      const mat = materials?.byId?.[facet.materialId];
      const TL_db = Array.isArray(mat?.transmission_loss_db)
        ? mat.transmission_loss_db[bandIdx]
        : null;
      if (!Number.isFinite(TL_db)) continue;
      tau = Math.pow(10, -TL_db / 10);
    }
    sum += F * tau;
  }
  if (sum <= 0) return -Infinity;
  return 10 * Math.log10(sum);
}

// ---------------------------------------------------------------------------
// computeCouplingForAllBands — Float32Array(NUM_BANDS) of C_couple per band.
//
// All values are ≤ 0 dB; entries with no facet contribution come back as
// −Infinity (caller treats as "no coupling at this band").
// ---------------------------------------------------------------------------
export function computeCouplingForAllBands(src, facets, materials) {
  const out = new Float32Array(NUM_BANDS);
  for (let k = 0; k < NUM_BANDS; k++) {
    const c = computeCouplingCoefficient(src, facets, materials, k);
    // Float32Array can't store −Infinity reliably across all hosts (it does
    // on Node + V8, but use a sentinel-friendly large-negative for the
    // missing-data case to keep downstream caller maths well-conditioned).
    // Caller still treats anything < −120 dB as "no meaningful coupling".
    out[k] = Number.isFinite(c) ? c : -Infinity;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHASE-1-DEP: minimal listWallFacets stub for tests + ad-hoc callers.
//
// Martina's Phase 1 listWallFacets(room) is the canonical producer. This
// stub exists ONLY so Phase 2 tests can run before Phase 1 lands; it
// builds a 6-facet rectangular envelope (N/E/S/W/floor/ceiling) from a
// shoebox room. When Phase 1 ships, callers should switch to her import;
// keep this stub for the Phase 2 unit tests so they don't regress on
// schema drift in her module.
//
// `room` shape (matches js/physics/wall-geometry.js conventions):
//   { width_m, depth_m, height_m }, plus a materialId to tag every face.
//
// Naming convention follows the PROJECT axis (CLAUDE.md §3):
//   state +y = NORTH (qibla). So y=0 is the SOUTH wall; y=D is the NORTH
//   wall. The outward normal of each face points AWAY from the room
//   interior. (The legacy wall-geometry.js parent_wall_* names — where
//   parent_wall_north is anchored at y=0 — are a separate historical
//   labelling used in the geometry resolver; this stub uses the project-
//   axis naming the rest of the codebase reads in.)
// ---------------------------------------------------------------------------
export function _stubRectangularFacets(room, materialId = 'concrete-painted') {
  const W = Number(room?.width_m) || 0;
  const D = Number(room?.depth_m) || 0;
  const H = Number(room?.height_m) || 0;
  if (W <= 0 || D <= 0 || H <= 0) return [];
  return [
    {
      // SOUTH wall at y = 0; outward normal points -y (out of the south face).
      id: 'wall_south',
      centroid: { x: W / 2, y: 0, z: H / 2 },
      normal: { x: 0, y: -1, z: 0 },
      area: W * H, materialId, isOpening: false,
    },
    {
      // NORTH wall at y = D (qibla); outward normal +y.
      id: 'wall_north',
      centroid: { x: W / 2, y: D, z: H / 2 },
      normal: { x: 0, y: 1, z: 0 },
      area: W * H, materialId, isOpening: false,
    },
    {
      id: 'wall_east',
      centroid: { x: W, y: D / 2, z: H / 2 },
      normal: { x: 1, y: 0, z: 0 },
      area: D * H, materialId, isOpening: false,
    },
    {
      id: 'wall_west',
      centroid: { x: 0, y: D / 2, z: H / 2 },
      normal: { x: -1, y: 0, z: 0 },
      area: D * H, materialId, isOpening: false,
    },
    {
      id: 'floor',
      centroid: { x: W / 2, y: D / 2, z: 0 },
      normal: { x: 0, y: 0, z: -1 },
      area: W * D, materialId, isOpening: false,
    },
    {
      id: 'ceiling',
      centroid: { x: W / 2, y: D / 2, z: H },
      normal: { x: 0, y: 0, z: 1 },
      area: W * D, materialId, isOpening: false,
    },
  ];
}

// Test-only export for white-box assertions (parity with reradiation.js).
export const _testing = { localAnglesFromSource, CLAMP_DISTANCE_MIN_M };
