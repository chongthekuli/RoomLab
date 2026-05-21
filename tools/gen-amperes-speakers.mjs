// Generator for the Amperes Electronics non-ceiling speaker catalogue.
//
// Produces one loudspeaker JSON per model in data/loudspeakers/, matching
// the RoomLAB schema used by the existing CS ceiling files. Run with:
//
//   node tools/gen-amperes-speakers.mjs
//
// WHY a generator instead of 30 hand-authored files: the `directivity`
// block is a per-angle attenuation grid that loudspeaker.js expands across
// frequency bands. Hand-authoring 30 of those invites copy-paste drift.
// This script derives every grid from one validated curve (see attCurve)
// scaled by each model's coverage angle, so the whole catalogue stays
// internally consistent and is regenerable when a number is corrected.
//
// DATA PROVENANCE (honesty matters — these ship in client proposals):
//   - REAL (ampereselectronics.com listing pages + catalogue p.50):
//     model list, rated power / 100 V taps, driver size, enclosure type,
//     and the ceiling-coax sensitivity anchor (CS620 6.5"=88 dB, CS840
//     8"=90 dB, CS518 5"=85 dB).
//   - ESTIMATED (documented in each file's `note`): sensitivity for
//     non-ceiling families, frequency limits, coverage angle, dimensions,
//     weight. Estimates use category-typical pro-PA values calibrated to
//     the anchor and to the driver size + power. The full-sphere
//     directivity map is ALWAYS modelled (Amperes never publishes polar
//     data) — same caveat the CS files already carry.
//
// Reviewed-by gate: the acoustic template numbers + attCurve shape are
// pending Dr. Chen (acoustics-engineer) sign-off before these files are
// committed. The 3D field contract (mount_type / shape / driver_count /
// dimensions_m) is consumed by Viktor's category geometry in scene.js +
// speaker-3d-preview.js.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'data', 'loudspeakers');

// Real specs scraped from the Amperes product pages (run scrape-amperes.mjs
// first). When a field is present here it OVERRIDES the estimate in the model
// table below; missing fields fall back to the estimate. Coverage angle / DI
// are never scraped (not published as polar data) — always modelled.
const SCRAPED = (() => {
  const f = join(__dirname, 'amperes-scraped.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
})();

// Standard analysis grid shared with the CS files + loudspeaker.js.
const AZ = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
const EL = [-90, -60, -30, 0, 30, 60, 90];
const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FLOOR_DB = -32;        // deepest off-axis attenuation we model

// Canonical −6 dB-at-60° directivity falloff, validated on the existing
// CS210 (120° nominal). Piecewise-linear in |angle|. A model with a
// different coverage angle reuses THIS shape, stretched by 60/halfAngle —
// so a 90° horn and a 120° cone share one validated curve.
const CANON = [             // [|angle|deg, attenuation dB]
  [0, 0], [30, -2], [60, -6], [90, -10.5], [120, -15], [150, -19.5], [180, -24],
];
function canonAtt(absDeg) {
  if (absDeg <= 0) return 0;
  if (absDeg >= 180) return -24;
  for (let i = 0; i < CANON.length - 1; i++) {
    const [a0, v0] = CANON[i], [a1, v1] = CANON[i + 1];
    if (absDeg >= a0 && absDeg <= a1) {
      const t = (absDeg - a0) / (a1 - a0);
      return v0 + t * (v1 - v0);
    }
  }
  return -24;
}
// Attenuation at `angle` for a beam of full coverage `covDeg` (−6 dB
// included angle). cov >= 360 → omnidirectional in that plane (0 dB).
function attCurve(angleDeg, covDeg) {
  if (covDeg >= 360) return 0;
  const halfAngle = covDeg / 2;
  const scaled = Math.abs(angleDeg) * (60 / halfAngle);   // map −6 dB pt → 60°
  return canonAtt(Math.min(scaled, 180));
}
// Full az×el 1 kHz grid: separable H/V, additive in dB, clamped.
function buildGrid(hCov, vCov) {
  return EL.map(el =>
    AZ.map(az => {
      const v = attCurve(az, hCov) + attCurve(el, vCov);
      return Math.round(Math.max(v, FLOOR_DB) * 10) / 10;
    }),
  );
}

// Directivity index from coverage solid angle.
//
// Two regimes, because a "180° half-angle" is NOT the same as omni:
//
//  (1) Both planes finite (cone / elliptical beam). For a cone of
//      half-angle h, Ω = 2π(1−cos h) and DI = 10·log10(4π/Ω) =
//      10·log10(2/(1−cos h)). Elliptical H≠V uses the geometric-mean
//      half-angle. Reproduces CS210 exactly (120° → DI 6 dB) and is
//      exact for symmetric H=V (lh201 50/50 → 13.3 dB).
//
//  (2) One plane omni (cov ≥ 360), the other a finite vertical half-
//      angle vh — a horizontal "equatorial band". The radiating solid
//      angle is a band of polar half-width vh about the horizon:
//      Ω = ∫₀^2π ∫_{90−vh}^{90+vh} sinθ dθ dφ = 4π·sin(vh), so
//      DI = 10·log10(4π/Ω) = 10·log10(1/sin vh). This is the physically
//      correct value for a round "omnidirectional" horn (Beranek &
//      Mellow 2nd ed. §4.x equatorial-band radiator; same result as the
//      classic "ring radiator" Q). Treating the omni plane as a 180°
//      cone in a geometric mean over-states DI by ~1.5 dB (HS815 would
//      read 2.7 dB instead of the correct 1.2 dB), which in a loud-PA
//      reverberant room shifts L_w by the same ~1.5 dB and biases the
//      reverberant floor — exactly the failure feedback_sound_power_needs_DI warns about.
function diFromCoverage(hCov, vCov) {
  const hOmni = hCov >= 360;
  const vOmni = vCov >= 360;
  let di;
  if (hOmni && vOmni) {
    di = 0;                                  // true omni — DI 0 by definition
  } else if (hOmni || vOmni) {
    // Equatorial-band radiator: omni in one plane, half-angle vh in the other.
    const finiteCov = hOmni ? vCov : hCov;
    const vh = (finiteCov / 2) * Math.PI / 180;
    di = 10 * Math.log10(1 / Math.sin(vh));
  } else {
    const hh = (hCov / 2) * Math.PI / 180;
    const vh = (vCov / 2) * Math.PI / 180;
    const heff = Math.sqrt(Math.max(hh, 1e-3) * Math.max(vh, 1e-3));
    di = 10 * Math.log10(2 / (1 - Math.cos(heff)));
  }
  return Math.max(0, Math.round(di * 10) / 10);
}

// On-axis band response from frequency limits: ~0 dB in band, −3 dB at the
// edges, steep rolloff beyond. Keeps the SpeakerLAB FR chart honest about
// each family's passband without claiming measured fine detail.
function bandResponse(lowHz, highHz) {
  const out = {};
  for (const f of BANDS) {
    let db;
    if (f < lowHz / 2) db = -18;
    else if (f < lowHz) db = -3 - 12 * Math.log2(lowHz / f);   // −12 dB/oct below
    else if (f <= highHz) db = (f < lowHz * 1.3 ? -1 : 0);
    else db = -3 - 14 * Math.log2(f / highHz);                  // steeper HF rolloff
    out[String(f)] = Math.round(Math.max(db, -30) * 10) / 10;
  }
  return out;
}

// Coarse fine-grain curve for the FR chart (same rolloff model on a denser
// log grid). Not measured — derived from passband limits.
const FINE_HZ = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
function fineResponse(lowHz, highHz) {
  return FINE_HZ.map(f => {
    let db;
    if (f < lowHz / 2) db = -22;
    else if (f < lowHz) db = -3 - 12 * Math.log2(lowHz / f);
    else if (f <= highHz) db = 0;
    else db = -3 - 14 * Math.log2(f / highHz);
    return [f, Math.round(Math.max(db, -30) * 10) / 10];
  });
}

const CSD_DEFAULT = { '125': 10, '250': 7, '500': 5, '1000': 4, '2000': 3.5, '4000': 3, '8000': 2.5, '16000': 2 };

// class_hint drives loudspeaker.js's per-band pattern widening.
function classHint(category) {
  if (category === 'horn') return 'horn';
  if (category === 'column') return 'line-element';
  return 'standard';
}

// Catalogue finish per model → drives the 3D cabinet colour (scene.js +
// speaker-3d-preview.js map the token to a material). Derived from the
// enclosure material noted in each model's description: aluminium-flare
// horns and weatherproof aluminium bodies = 'aluminium'; ABS paging horns
// = 'grey'; ABS/metal indoor boxes, slim columns and projectors = 'white';
// FS650 ships in a black enclosure; garden/landscape = 'green'. These are
// best-guess catalogue matches — correct any single one here and rerun.
//   white | off-white | aluminium | grey | black | green
const FINISH = {
  bs410: 'white', bs506: 'white', bs508: 'white',
  fs420: 'white', fs425: 'white', fs338: 'white', fs640: 'white', fs650: 'black',
  cl902: 'white', cl904: 'white', cl908: 'white', cl912: 'white', cl916: 'white',
  cl740: 'aluminium', cl780: 'aluminium',
  hs815: 'aluminium', hs830: 'aluminium', hs820: 'grey', hs822: 'grey',
  hs725: 'grey', hs750: 'aluminium', hs810: 'aluminium', hs880: 'aluminium',
  lh100: 'grey', lh201: 'aluminium',
  sp219: 'aluminium', sp220: 'white', sp319: 'aluminium',
  sg320: 'green', ps820: 'white',
};

// ---------------------------------------------------------------------------
// MODEL TABLE. One row per new model.
//   id, model, category(mount_type), driver_in, drivers, watts (max tap),
//   taps (label), sens (dB 1W/1m), low/high (Hz), hCov/vCov (deg),
//   w/h/d (m), shape, weight (kg), [coax], [ip], [desc]
// ---------------------------------------------------------------------------
const MODELS = [
  // ---- Surface-mount box / wall (BS) ----
  { id: 'bs410', model: 'Amperes BS410', cat: 'surface-mount', driver_in: 4, drivers: 1, watts: 10, taps: '1/3/6/10 W', sens: 89, low: 130, high: 15000, hCov: 150, vCov: 130, w: 0.165, h: 0.165, d: 0.085, shape: 'box-halfmoon', weight: 0.8, desc: '4" dual-cone half-moon surface speaker, 1/3/6/10 W 100 V taps, aluminium grille — wall or ceiling-slab PA / EVAC.' },
  { id: 'bs506', model: 'Amperes BS506', cat: 'surface-mount', driver_in: 5, drivers: 1, watts: 6, taps: '1/3/6 W', sens: 90, low: 110, high: 15000, hCov: 140, vCov: 120, w: 0.20, h: 0.20, d: 0.10, shape: 'box', weight: 1.2, desc: '5" dual-cone surface-mount box speaker in ABS, 1/3/6 W 100 V taps.' },
  { id: 'bs508', model: 'Amperes BS508', cat: 'surface-mount', driver_in: 5, drivers: 1, watts: 10, taps: '2.5/5/10 W', sens: 90, low: 110, high: 16000, hCov: 140, vCov: 120, w: 0.20, h: 0.20, d: 0.105, shape: 'box', weight: 1.3, desc: '5" 10 W 100 V low-profile box speaker, aluminium grille, vandal-resistant mount.' },

  // ---- Full-range music box (FS) ----
  { id: 'fs420', model: 'Amperes FS420', cat: 'full-range', driver_in: 4, drivers: 1, watts: 20, taps: '5/10/20 W', sens: 89, low: 90, high: 18000, hCov: 110, vCov: 100, w: 0.16, h: 0.26, d: 0.16, shape: 'box', weight: 2.2, tweeter: true, desc: '4" full-range foreground-music speaker with tweeter, 20 W 100 V line.' },
  { id: 'fs425', model: 'Amperes FS425', cat: 'full-range', driver_in: 4, drivers: 1, watts: 20, taps: '5/10/20 W', sens: 89, low: 95, high: 18000, hCov: 110, vCov: 100, w: 0.17, h: 0.27, d: 0.17, shape: 'box', weight: 2.5, tweeter: true, ip: 'IP65', desc: '4" IP65 weatherproof full-range music speaker, indoor/outdoor, 20 W 100 V line.' },
  { id: 'fs338', model: 'Amperes FS338', cat: 'full-range', driver_in: 4, drivers: 2, watts: 40, taps: '10/20/40 W', sens: 91, low: 85, high: 18000, hCov: 100, vCov: 60, w: 0.18, h: 0.40, d: 0.18, shape: 'box', weight: 4.0, tweeter: true, desc: 'Dual 4" full-range music speaker, 40 W 100 V line, vertical two-driver baffle.' },
  { id: 'fs640', model: 'Amperes FS640', cat: 'full-range', driver_in: 6, drivers: 1, watts: 40, taps: '10/20/40 W', sens: 91, low: 80, high: 18000, hCov: 100, vCov: 90, w: 0.22, h: 0.34, d: 0.22, shape: 'box', weight: 4.5, tweeter: true, desc: '6" full-range foreground-music speaker with tweeter, 40 W 100 V line.' },
  { id: 'fs650', model: 'Amperes FS650', cat: 'full-range', driver_in: 6, drivers: 1, watts: 50, taps: '12.5/25/50 W', sens: 91, low: 75, high: 19000, hCov: 100, vCov: 90, w: 0.23, h: 0.36, d: 0.23, shape: 'box', weight: 5.0, tweeter: true, desc: '6" + tweeter full-range music speaker, 50 W 100 V line, black enclosure.' },

  // ---- Column (CL) — slim CL900 series (small drivers) ----
  { id: 'cl902', model: 'Amperes CL902', cat: 'column', driver_in: 2.5, drivers: 2, watts: 10, taps: '2.5/5/10 W', sens: 88, low: 150, high: 16000, hCov: 140, vCov: 60, w: 0.08, h: 0.30, d: 0.085, shape: 'column', weight: 1.5, desc: 'Slim-line column, 2 × small drivers, 10 W 100 V line — speech reinforcement.' },
  { id: 'cl904', model: 'Amperes CL904', cat: 'column', driver_in: 2.5, drivers: 4, watts: 20, taps: '5/10/20 W', sens: 90, low: 130, high: 16000, hCov: 140, vCov: 45, w: 0.08, h: 0.45, d: 0.085, shape: 'column', weight: 2.2, desc: 'Slim-line column, 4 drivers, 20 W 100 V line, controlled vertical pattern.' },
  { id: 'cl908', model: 'Amperes CL908', cat: 'column', driver_in: 2.5, drivers: 8, watts: 40, taps: '10/20/40 W', sens: 91, low: 120, high: 16000, hCov: 140, vCov: 30, w: 0.09, h: 0.66, d: 0.09, shape: 'column', weight: 3.5, desc: 'Slim-line column, 8 drivers, 40 W 100 V line, narrow vertical for reverberant spaces.' },
  { id: 'cl912', model: 'Amperes CL912', cat: 'column', driver_in: 2.5, drivers: 12, watts: 60, taps: '15/30/60 W', sens: 92, low: 110, high: 16000, hCov: 140, vCov: 22, w: 0.09, h: 0.90, d: 0.09, shape: 'column', weight: 5.0, desc: 'Slim-line column, 12 drivers, 60 W 100 V line, tight vertical control.' },
  { id: 'cl916', model: 'Amperes CL916', cat: 'column', driver_in: 2.5, drivers: 16, watts: 80, taps: '20/40/80 W', sens: 93, low: 100, high: 16000, hCov: 140, vCov: 18, w: 0.10, h: 1.15, d: 0.10, shape: 'column', weight: 6.5, desc: 'Slim-line column, 16 drivers, 80 W 100 V line, long-throw speech array.' },
  // CL700 weatherproof full-range columns (4" drivers, aluminium, IP65)
  { id: 'cl740', model: 'Amperes CL740', cat: 'column', driver_in: 4, drivers: 4, watts: 40, taps: '10/20/40 W', sens: 91, low: 100, high: 15000, hCov: 130, vCov: 35, w: 0.13, h: 0.50, d: 0.13, shape: 'column', weight: 4.0, ip: 'IP65', desc: 'Weatherproof full-range column, 4 × 4" drivers, 40 W 100 V line, aluminium body, IP65.' },
  { id: 'cl780', model: 'Amperes CL780', cat: 'column', driver_in: 4, drivers: 8, watts: 80, taps: '20/40/80 W', sens: 93, low: 90, high: 15000, hCov: 130, vCov: 22, w: 0.13, h: 0.95, d: 0.13, shape: 'column', weight: 7.5, ip: 'IP65', desc: 'Weatherproof full-range column, 8 × 4" drivers, 80 W 100 V line, aluminium body, IP65.' },

  // ---- Horn (HS / LH) ----
  { id: 'hs815', model: 'Amperes HS815', cat: 'horn', driver_in: 8, drivers: 1, watts: 15, taps: '3.75/7.5/15 W', sens: 104, low: 350, high: 6000, hCov: 360, vCov: 100, w: 0.21, h: 0.21, d: 0.20, shape: 'horn-round', weight: 1.2, ip: 'IP65', desc: '8" round aluminium horn, omnidirectional coverage, multiple taps, 15 W 100 V, IP65.' },
  { id: 'hs830', model: 'Amperes HS830', cat: 'horn', driver_in: 12, drivers: 1, watts: 30, taps: '7.5/15/30 W', sens: 107, low: 300, high: 6000, hCov: 360, vCov: 100, w: 0.30, h: 0.30, d: 0.25, shape: 'horn-round', weight: 2.0, ip: 'IP65', desc: '12" round aluminium horn, omnidirectional coverage, multiple taps, 30 W 100 V, IP65.' },
  { id: 'hs820', model: 'Amperes HS820', cat: 'horn', driver_in: 6, drivers: 1, watts: 15, taps: '3.75/7.5/15 W', sens: 105, low: 350, high: 7000, hCov: 100, vCov: 70, w: 0.21, h: 0.16, d: 0.25, shape: 'horn-rect', weight: 1.0, ip: 'IP65', desc: '6"×8" ABS rectangular-flare horn, directional, 15 W 100 V, IP65.' },
  { id: 'hs822', model: 'Amperes HS822', cat: 'horn', driver_in: 8, drivers: 1, watts: 30, taps: '7.5/15/30 W', sens: 108, low: 300, high: 7000, hCov: 90, vCov: 60, w: 0.28, h: 0.20, d: 0.30, shape: 'horn-rect', weight: 1.8, ip: 'IP65', desc: '11"×8" ABS rectangular-flare horn, directional, 30 W 100 V, IP65.' },
  { id: 'hs725', model: 'Amperes HS725', cat: 'horn', driver_in: 8, drivers: 1, watts: 30, taps: '7.5/15/30 W', sens: 106, low: 200, high: 12000, hCov: 110, vCov: 90, w: 0.30, h: 0.30, d: 0.30, shape: 'horn-round', weight: 2.0, ip: 'IP65', desc: '30 W music horn, clear sound with powerful projection, IP65.' },
  { id: 'hs750', model: 'Amperes HS750', cat: 'horn', driver_in: 8, drivers: 1, watts: 50, taps: '12.5/25/50 W', sens: 107, low: 180, high: 12000, hCov: 100, vCov: 80, w: 0.34, h: 0.34, d: 0.32, shape: 'horn-rect', weight: 2.8, ip: 'IP65', desc: '50 W weatherproof clear horn (rectangular flare) for large indoor/outdoor areas, IP65.' },
  { id: 'hs810', model: 'Amperes HS810', cat: 'horn', driver_in: 14, drivers: 1, watts: 100, taps: '25/50/100 W', sens: 110, low: 250, high: 8000, hCov: 90, vCov: 90, w: 0.36, h: 0.36, d: 0.40, shape: 'horn-round', weight: 4.0, ip: 'IP65', desc: '14" round flare, long-range voice and non-bass music, aluminium body, IP65.' },
  { id: 'hs880', model: 'Amperes HS880', cat: 'horn', driver_in: 20, drivers: 1, watts: 80, taps: '20/40/80 W', sens: 112, low: 200, high: 7000, hCov: 70, vCov: 70, w: 0.51, h: 0.51, d: 0.55, shape: 'horn-round', weight: 7.0, ip: 'IP65', desc: '20" aluminium-flare long-throw horn, 80 W 100 V, IP65.' },
  { id: 'lh100', model: 'Amperes LH100', cat: 'horn', driver_in: 16, drivers: 1, watts: 100, taps: '25/50/100 W', sens: 113, low: 250, high: 6000, hCov: 60, vCov: 60, w: 0.45, h: 0.45, d: 0.55, shape: 'horn-round', weight: 8.0, ip: 'IP54', desc: 'High-power tunnel-EVAC horn, controlled dispersion, fire-retardant fibreglass body, IP54.' },
  { id: 'lh201', model: 'Amperes LH201', cat: 'horn', driver_in: 21, drivers: 1, watts: 100, taps: '25/50/100 W', sens: 114, low: 200, high: 6000, hCov: 50, vCov: 50, w: 0.53, h: 0.53, d: 0.60, shape: 'horn-round', weight: 9.0, ip: 'IP65', desc: '21" long-throw horn, aluminium enclosure, long-distance projection, 100 W 100 V, IP65.' },

  // ---- Sound projector (SP) — cylindrical tube ----
  { id: 'sp219', model: 'Amperes SP219', cat: 'sound-projector', driver_in: 5, drivers: 1, watts: 15, taps: '3.75/7.5/15 W', sens: 92, low: 200, high: 12000, hCov: 120, vCov: 110, w: 0.14, h: 0.26, d: 0.14, shape: 'cylinder', weight: 1.5, desc: '15 W unidirectional sound projector, 5" PP-cone driver, rust-resistant aluminium body.' },
  { id: 'sp220', model: 'Amperes SP220', cat: 'sound-projector', driver_in: 5, drivers: 1, watts: 20, taps: '5/10/20 W', sens: 92, low: 180, high: 13000, hCov: 120, vCov: 110, w: 0.13, h: 0.28, d: 0.13, shape: 'cylinder', weight: 1.3, ip: 'IP65', desc: '20 W IP65 sound projector, durable ABS body, metal grille, selectable taps.' },
  { id: 'sp319', model: 'Amperes SP319', cat: 'sound-projector', driver_in: 5, drivers: 2, watts: 40, taps: '10/20/40 W', sens: 93, low: 180, high: 12000, hCov: 120, vCov: 110, w: 0.14, h: 0.48, d: 0.14, shape: 'cylinder-bi', weight: 2.8, desc: '40 W bidirectional sound projector, dual PP-cone drivers firing both ends, aluminium body.' },

  // ---- Garden / landscape (SG) ----
  { id: 'sg320', model: 'Amperes SG320', cat: 'garden', driver_in: 5, drivers: 1, watts: 20, taps: '5/10/20 W', sens: 88, low: 100, high: 15000, hCov: 360, vCov: 120, w: 0.18, h: 0.32, d: 0.18, shape: 'bollard', weight: 2.5, ip: 'IP65', desc: '20 W 360° weatherproof garden/landscape speaker, 10 W tap option, IP65.' },

  // ---- Pendant ball (PS) ----
  { id: 'ps820', model: 'Amperes PS820', cat: 'pendant', driver_in: 8, drivers: 1, watts: 20, taps: '5/10/20 W', sens: 89, low: 90, high: 18000, hCov: 360, vCov: 130, w: 0.25, h: 0.25, d: 0.25, shape: 'sphere', weight: 2.0, desc: '20 W 8" pendant ball speaker, 360° coverage, adjustable taps — high-ceiling foreground music.' },
];

function buildDef(m) {
  // Merge scraped real specs over the estimate. real wins; missing → estimate.
  const sc = SCRAPED[m.id] || {};
  const sens = sc.sens_db ?? m.sens;
  const low = sc.freq_hz ? sc.freq_hz[0] : m.low;
  const high = sc.freq_hz ? sc.freq_hz[1] : m.high;
  const dims = sc.dims_mm
    ? { w: +(sc.dims_mm.w_mm / 1000).toFixed(4), h: +(sc.dims_mm.h_mm / 1000).toFixed(4), d: +(sc.dims_mm.d_mm / 1000).toFixed(4) }
    : { w: m.w, h: m.h, d: m.d };
  const weight = sc.net_weight_kg ?? m.weight;

  const maxSpl = Math.round((sens + 10 * Math.log10(m.watts)) * 10) / 10;
  const di = diFromCoverage(m.hCov, m.vCov);
  const dispNominal = Math.min(m.hCov, 360) >= 360 ? 360 : Math.round((m.hCov + m.vCov) / 2);

  // Honest provenance: which fields are published vs estimated vs modelled.
  const real = [], est = [];
  (sc.sens_db != null ? real : est).push('sensitivity');
  (sc.freq_hz ? real : est).push('frequency response');
  (sc.dims_mm ? real : est).push('dimensions');
  (sc.net_weight_kg != null ? real : est).push('weight');
  const provNote =
    `${m.desc} Power taps and driver size are from the public Amperes catalogue. `
    + (real.length ? `Published Amperes product-page specifications: ${real.join(', ')}. ` : '')
    + (est.length ? `ESTIMATED (not published): ${est.join(', ')}. ` : '')
    + `Coverage angle and off-axis directivity are MODELLED (axisymmetric/elliptical from the nominal coverage) — Amperes does not publish polar data. `
    + `Max SPL is an anechoic on-axis peak (sensitivity + 10·log₁₀ rated power): 100 V-line transformer insertion loss and thermal-vs-acoustic limits are not modelled (~1–3 dB optimistic, not a continuous tap-limited figure). `
    + `The directivity index is a single mid/HF coverage-derived value; LF directivity is over-stated. Verify against the official datasheet before sign-off.`;

  const def = {
    schema_version: '1.1',
    id: `${m.id}-v1`,
    manufacturer: 'Amperes Electronics',
    model: m.model,
    license: 'Catalogue data © Amperes Electronics — power taps, driver size, sensitivity, frequency response, dimensions and weight from public spec sheets where published; coverage/directivity modelled (see note).',
    note: provNote,
    source_url: sc._url ? `https://www.ampereselectronics.com${sc._url}` : undefined,
    mount_type: m.cat,
    physical: {
      weight_kg: weight,
      dimensions_m: dims,
      shape: m.shape,
      finish: FINISH[m.id] ?? 'white',
      driver_size_inches: m.driver_in,
      driver_count: m.drivers,
    },
    electrical: {
      nominal_impedance_ohm: 8,
      line_voltage: '100V',
      power_taps: m.taps,
      max_input_watts: m.watts,
      max_spl_db: maxSpl,
    },
    acoustic: {
      sensitivity_db_1w_1m: sens,
      frequency_range_hz: [low, high],
      frequency_bands_hz: BANDS.slice(),
      directivity_index_db: di,
      nominal_dispersion_deg: dispNominal,
      on_axis_response_db: bandResponse(low, high),
      fr_fine_db: fineResponse(low, high),
      csd_ms: { ...CSD_DEFAULT },
    },
    placement: {
      position_m: { x: 0, y: 0, z: 2.5 },
      aim_deg: { yaw: 0, pitch: 0, roll: 0 },
    },
    directivity: {
      angular_resolution_deg: 30,
      class_hint: classHint(m.cat),
      azimuth_deg: AZ.slice(),
      elevation_deg: EL.slice(),
      attenuation_db: { '1000': buildGrid(m.hCov, m.vCov) },
    },
  };
  if (m.coax) def.acoustic.coaxial = true;
  if (m.tweeter) def.physical.has_tweeter = true;
  if (m.ip) def.physical.ip_rating = m.ip;
  return def;
}

let written = 0;
const catalogLines = [];
for (const m of MODELS) {
  const def = buildDef(m);
  const file = join(OUT_DIR, `amperes-${m.id}.json`);
  writeFileSync(file, JSON.stringify(def, null, 2) + '\n', 'utf8');
  written++;
  const inch = Number.isInteger(m.driver_in) ? `${m.driver_in}"` : `${m.driver_in}"`;
  catalogLines.push(`  { url: 'data/loudspeakers/amperes-${m.id}.json', label: '${m.model.replace('Amperes ', 'Amperes ')} (${inch} ${m.watts} W, ${m.cat})' },`);
}

console.log(`Wrote ${written} speaker JSON files to ${OUT_DIR}\n`);
console.log('--- SPEAKER_CATALOG entries (paste into js/shared/speaker-catalog.js) ---');
console.log(catalogLines.join('\n'));
