// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Sub-volume layouts for FurnitureLAB acoustic routing (v=677,
// 2026-05-27). One pure helper per visual family — given a catalogue
// row, return the list of axis-aligned sub-bounding-boxes that the
// precision ray-tracer + ray-viz should see.
//
// Why this lives separately from scene.js / scene-snapshot.js: the
// SAME layout drives BOTH the visible 3D mesh (Three.js geometries
// in scene.js _buildFurnitureMesh) AND the acoustic snapshot
// (precision tracer bboxes in scene-snapshot.js). Having them diverge
// is how the user gets bugs like "rays bounce off invisible bbox face"
// or "rays can't pass under the table" (v=668-676 history).
//
// Architecture
// ============
// Each layout returns Array<{ bounds, role }>:
//
//   bounds: [xMin, yMin, zMin, xMax, yMax, zMax]
//     LOCAL coords centred on the placed-item position (cx, cy) in
//     state-frame. Y is depth-into-room (state.y direction), Z is up.
//     Caller adds (cx, cy) to xMin/yMin and xMax/yMax to get world
//     coords. zMin/zMax stay as-is (no z offset).
//
//   role: 'porous' | 'reflective_main' | 'frame'
//     'porous'           — Beer-Lambert sink; receives the full
//                          catalogue A_obj as μ = A_obj / (4·V_box).
//                          Only one porous sub-volume per item
//                          (otherwise the A_obj would be split or
//                          double-counted).
//     'reflective_main'  — triangulated into wall BVH with the
//                          per-item 'furniture:<catalogueId>' material
//                          (α = A_obj / S_main_total).
//     'frame'            — triangulated into wall BVH with the shared
//                          'furniture-frame:generic' material
//                          (α = 0.05 flat — generic wood/plastic).
//
// Adding a new visual family
// ==========================
// 1. Add a layout function (w, d, h) => [{bounds, role}].
// 2. Register it in LAYOUTS below under the family's key.
// 3. (Optional) Add a matching scene.js 3D builder so the visible
//    mesh tracks the bboxes — same dimensions.
// 4. Add an integration test in tests/furniture-sub-volumes.test.mjs
//    asserting the expected sub-volume count and roles.
// No changes needed in scene-snapshot.js, tracer-core.js, or the BVH.

// --- seat family: chairs (theater + office, occupied + empty pairs) ---
// Cushion porous + 4 legs + 2 arms + back panel reflective frame.
// Geometry matches scene.js _build_seat so the visible chair sits
// on its own legs (not inside-the-bbox).
function SEAT_LAYOUT(w, d, h) {
  const seatTop_z = Math.min(0.50, h * 0.42);
  const cushHi_z  = Math.min(0.55, h * 0.46);
  const armHi_z   = Math.min(0.72, h * 0.55);
  const legSize   = 0.10;
  const legInset  = 0.08;
  const cushW     = w * 0.86;
  const cushD     = d * 0.84;
  const cushYOff  = d * (0.46 - 0.50);   // local offset from bbox centre

  const subs = [];

  // Cushion porous slab.
  subs.push({
    bounds: [
      -cushW / 2, cushYOff - cushD / 2, seatTop_z,
       cushW / 2, cushYOff + cushD / 2, cushHi_z,
    ],
    role: 'porous',
  });

  // 4 corner legs.
  for (const sx of [-1, +1]) {
    for (const sy of [-1, +1]) {
      const lcx = sx * (w / 2 - legInset);
      const lcy = sy * (d / 2 - legInset);
      subs.push({
        bounds: [
          lcx - legSize / 2, lcy - legSize / 2, 0,
          lcx + legSize / 2, lcy + legSize / 2, seatTop_z,
        ],
        role: 'frame',
      });
    }
  }

  // 2 armrests (skipped on narrow seats < 0.45 m).
  if (w >= 0.45) {
    for (const sx of [-1, +1]) {
      const acx = sx * (w / 2 - 0.04);
      subs.push({
        bounds: [
          acx - 0.04, cushYOff - d * 0.39, seatTop_z,
          acx + 0.04, cushYOff + d * 0.39, armHi_z,
        ],
        role: 'frame',
      });
    }
  }

  // Back panel.
  subs.push({
    bounds: [
      -cushW / 2, d / 2 - 0.10, cushHi_z,
       cushW / 2, d / 2 - 0.02, h,
    ],
    role: 'frame',
  });

  return subs;
}

// --- slab-on-legs family: tables, desks, lecterns ---
// Top slab + 4 corner legs. Under-table space is air (no bbox), so
// rays pass freely between the legs and under the slab (fixed Bug 2
// from the v=676 UAT where the whole bbox was reflective and rays
// couldn't pass under the table).
function SLAB_ON_LEGS_LAYOUT(w, d, h) {
  const slabThk = Math.min(0.05, h * 0.08);
  const legR    = Math.min(0.04, w * 0.04, d * 0.04);
  const inset   = 0.05;

  const subs = [];

  // Top slab — full footprint × slabThk at the top.
  subs.push({
    bounds: [-w / 2, -d / 2, h - slabThk, w / 2, d / 2, h],
    role: 'reflective_main',
  });

  // 4 corner legs.
  for (const sx of [-1, +1]) {
    for (const sy of [-1, +1]) {
      const lcx = sx * (w / 2 - inset);
      const lcy = sy * (d / 2 - inset);
      subs.push({
        bounds: [lcx - legR, lcy - legR, 0, lcx + legR, lcy + legR, h - slabThk],
        role: 'frame',
      });
    }
  }
  return subs;
}

// --- vertical-box family: bookshelves, server racks ---
// These ARE solid boxes in reality — loaded bookshelves are filled
// with books, server racks are filled with rackmount hardware. Whole
// bbox is reflective. No sub-division.
function VERTICAL_BOX_LAYOUT(w, d, h) {
  return [{
    bounds: [-w / 2, -d / 2, 0, w / 2, d / 2, h],
    role: 'reflective_main',
  }];
}

// --- flat-pad family: audience blocks, prayer mats ---
// Porous slab, split into two regimes by catalogue height (Dr. Chen
// 2026-05-31):
//   • Thin mats / floor pads (height ≤ 0.10 m): a true floor-hugging slab.
//     A direct ray at ear height passes ABOVE it — correct, a prayer mat
//     doesn't shadow a standing talker.
//   • Seated / occupied audience blocks (height > 0.10 m): a porous COLUMN
//     from floor to ~0.92·height. The visible bodies stand ~1.1 m; the
//     acoustically interacting mass (heads / shoulders / torsos of a SEATED
//     occupied audience) fills floor→~1.1 m. Raising the box lets the
//     Beer-Lambert direct-shadow act at ear height — reconciling this
//     analytical helper with the PRECISION TRACER, which already uses the
//     full footprint volume (μ = A_obj/(4·w·d·h)). A_obj is UNCHANGED: the
//     same total ISO-354 absorption spread through a taller V gives a lower
//     per-metre μ, but the now-non-zero in-box path length makes up for it
//     (~0.85 dB grazing loss per 1 m block at 1 kHz). The top 0.08·h is air
//     above the heads, so a listener whose ears clear the crowd (z > 1.1 m)
//     is not shadowed.
//
// CAVEAT (do NOT claim otherwise): this models BULK GRAZING ABSORPTION, a
// smooth broadband loss. It is NOT the seat-dip effect — the deep,
// frequency-selective low-mid notch (~100-300 Hz, 10-15 dB) from interference
// over periodic seat-row impedance (Schultz-Watters 1964; ISO 9613-2 §7.5).
// The seat-dip needs row-spacing geometry this tier lacks (P3 backlog). This
// model under-predicts LF loss over a deep raked audience and applies no notch.
function FLAT_PAD_LAYOUT(w, d, h) {
  if (h <= 0.10) {
    const padThk = Math.min(0.04, Math.max(0.02, h));
    return [{
      bounds: [-w / 2 * 0.98, -d / 2 * 0.98, 0, w / 2 * 0.98, d / 2 * 0.98, padThk],
      role: 'porous',
    }];
  }
  const colTop = h * 0.92;
  return [{
    bounds: [-w / 2 * 0.98, -d / 2 * 0.98, 0, w / 2 * 0.98, d / 2 * 0.98, colTop],
    role: 'porous',
  }];
}

const LAYOUTS = {
  'seat':         SEAT_LAYOUT,
  'slab-on-legs': SLAB_ON_LEGS_LAYOUT,
  'vertical-box': VERTICAL_BOX_LAYOUT,
  'flat-pad':     FLAT_PAD_LAYOUT,
};

/**
 * Return the list of sub-bboxes for a catalogue row, picked by
 * visual.family and adapted to the row's interaction_mode.
 *
 * - 'porous' mode: collapse every sub-volume to role='porous' (entire
 *   item behaves as a Beer-Lambert volume — useful for items whose
 *   family layout exists but should NOT have reflective shell parts,
 *   like a fully-upholstered ottoman in the seat family).
 * - 'reflective' mode: collapse every sub-volume to role='reflective_main'
 *   plus existing 'frame' sub-volumes stay (legs are still frame
 *   material). For families where the natural layout is already all
 *   reflective (slab-on-legs, vertical-box), this is a no-op.
 * - 'hybrid' mode (default for layouts that mix roles): use the
 *   layout exactly as declared.
 *
 * @param {object} row  Catalogue row from data/furniture/catalogue.json
 * @returns {Array<{bounds: number[6], role: 'porous'|'reflective_main'|'frame'}>}
 */
export function getSubVolumes(row) {
  const family = row?.visual?.family ?? 'vertical-box';
  const mode   = row?.acoustics?.interaction_mode ?? 'porous';
  const w      = Math.max(0.01, row?.footprint?.width_m  ?? 0.5);
  const d      = Math.max(0.01, row?.footprint?.depth_m  ?? 0.5);
  const h      = Math.max(0.01, row?.footprint?.height_m ?? 1.0);

  const layoutFn = LAYOUTS[family] ?? VERTICAL_BOX_LAYOUT;
  const raw = layoutFn(w, d, h);

  if (mode === 'porous') {
    // Force every part to porous. Fallback for items tagged porous
    // even when their family layout normally splits roles.
    return raw.map(sub => ({ bounds: sub.bounds, role: 'porous' }));
  }
  if (mode === 'reflective') {
    // Keep 'frame' as frame (legs stay frame-material on reflective
    // tables/lecterns); promote any 'porous' sub-volume to 'main'
    // so the item reads as a uniform reflective object.
    return raw.map(sub => ({
      bounds: sub.bounds,
      role: sub.role === 'porous' ? 'reflective_main' : sub.role,
    }));
  }
  // 'hybrid' — layout exactly as declared.
  return raw;
}
