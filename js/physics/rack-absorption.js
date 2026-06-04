// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Rack absorption helper — pure, Node-testable, no DOM.
//
// Each DeviceLAB-placed rack (state.rackSystem.racks entry) carries a
// rackModelKey pointing at a row in data/racks/catalogue.json. The row
// exposes physical dimensions + door/side/vent configuration. From that
// we compute per-band equivalent absorption area A_obj for the room
// acoustics (Sabine + Eyring parallel-A term, same path the
// FurnitureLAB helper uses — see js/physics/furniture-absorption.js).
//
// Dr. Chen's physics spec (slice 4, 2026-05-27):
//   - Material-swap pattern, NOT a single-α scale. The empty rack front
//     reads as a perforated-panel-over-large-cavity Helmholtz absorber;
//     the loaded rack front reads as a perforated-panel-over-small-
//     cavity + lossy-chassis-faceplate. Different absorber topologies.
//   - Linear blend on fillRatio for partial loads:
//       α_front(f) = (1 − fillRatio) · α_empty(f) + fillRatio · α_loaded(f)
//   - Open-frame rack empty → short-circuit (returns 0; the two 40 mm
//     top/bottom plates are below the precision-tracer noise floor).
//   - Open-frame rack loaded → front face reads as the loaded chassis
//     array (the empty side has no surface in front of the user, so
//     fillRatio modulates between "nothing there" and "chassis array").
//   - fillRatio = clamp(Σ slots[i].uHeight / rackDef.u, 0, 1). 1U blank
//     covers count — they occupy U-height and reflect like solid plates.
//   - Side panels (steel) DO NOT change with fill. Heat is a DC effect;
//     the panel impedance is the same hot or cold.
//   - Reradiation skipped at current fidelity tier (Cox & D'Antonio
//     §6 / Maa 1998 is the absorber model, not the panel-resonance
//     re-radiator). Flag in P3 backlog: broadcast machine rooms with
//     20+ enclosed racks may under-predict by 1-2 dB at 80-150 Hz.
//   - Wall-shadowing (rack flush against wall) is the CALLER's job.
//     The sub-volumes module reports all 4 exterior side faces + top;
//     a caller with wall-geometry context decides whether to subtract.
//
// `catalogue` is a Map<rackModelKey, def> built once at startup by the
// loader. `materials` is the full materials catalogue (Map-of-byId or
// {byId: {...}, frequency_bands_hz: [...]}) — same shape the rt60.js
// path consumes.

// Material IDs Dr. Chen specced (data/materials.json schema 1.5):
const M_PANEL     = 'rack_metal_painted_panel';      // sides + rear + solid top
const M_DOOR_F_E  = 'rack_door_mesh_glass_empty';    // enclosed front, empty cavity
const M_DOOR_F_L  = 'rack_door_mesh_glass_loaded';   // enclosed front, loaded
const M_DOOR_R    = 'rack_door_perforated_rear';     // enclosed rear, perforated steel
const M_CHASSIS   = 'rack_chassis_array_loaded';     // open-frame front, loaded chassis
const M_TOP_VENT  = 'rack_top_vented';               // enclosed top, vented strip

/**
 * Compute the fillRatio of a single rack from its slot occupancy.
 * Clamped to [0, 1] so an oversubscribed file (data-entry mistake)
 * doesn't drive α past the loaded value.
 *
 * @param {object} rack     state.rackSystem.racks[i]
 * @param {object} rackDef  data/racks/catalogue.json racks[rackModelKey]
 * @returns {number}        fillRatio ∈ [0, 1]
 */
export function rackFillRatio(rack, rackDef) {
  if (!rack || !rackDef) return 0;
  const totalU = Math.max(1, Number(rackDef.u) || 1);
  const slots = Array.isArray(rack.slots) ? rack.slots : [];
  let used = 0;
  for (const s of slots) {
    const u = Number(s?.uHeight);
    if (Number.isFinite(u) && u > 0) used += u;
  }
  return Math.max(0, Math.min(1, used / totalU));
}

/**
 * Return the list of acoustic sub-volumes for one rack — one entry per
 * exterior face that interacts with the room. Each entry is:
 *   { face: 'front'|'rear'|'side_left'|'side_right'|'top',
 *     area_m2: number,
 *     materialIdEmpty: string,        // material at fillRatio = 0
 *     materialIdLoaded: string,       // material at fillRatio = 1
 *     fillBlend: boolean              // true → caller blends; false → use materialIdEmpty as-is
 *   }
 *
 * The caller computes effective α(f) per face as:
 *   if (fillBlend) α = (1−r)·α(materialIdEmpty) + r·α(materialIdLoaded)
 *   else           α = α(materialIdEmpty)
 *
 * Returns [] for open-frame rack with fillRatio = 0 (Dr. Chen short-circuit).
 *
 * @param {object} rack     state.rackSystem.racks[i]
 * @param {object} rackDef  catalogue entry
 * @returns {Array<object>} per-face sub-volumes
 */
export function getRackSubVolumes(rack, rackDef) {
  if (!rack || !rackDef) return [];
  const style = rackDef.style || 'open-frame';
  const fillRatio = rackFillRatio(rack, rackDef);

  // Open-frame empty: Dr. Chen short-circuit. Two 40 mm × 600 mm plates
  // of painted steel = ~0.05 m² at α=0.05 → 0.0025 m² Sabine. Below
  // precision floor; return nothing rather than pretend it changes the
  // room.
  if (style === 'open-frame' && fillRatio === 0) return [];

  const w_m = (Number(rackDef.outer_w_mm) || 600) / 1000;
  const d_m = (Number(rackDef.outer_d_mm) || 600) / 1000;
  // Outer height includes the castor stack — the acoustic-active height
  // is the rack body, not the wheels. Subtract castor_h_mm.
  const outerH_mm = Number(rackDef.outer_h_mm) || 1000;
  const castorH_mm = Number(rackDef.castor_h_mm) || 0;
  const h_m = Math.max(0.05, (outerH_mm - castorH_mm) / 1000);

  const sideArea  = d_m * h_m;
  const frontArea = w_m * h_m;
  const rearArea  = w_m * h_m;
  const topArea   = w_m * d_m;

  const subs = [];

  if (style === 'enclosed') {
    // FRONT: mesh-glass door. Material swaps empty ↔ loaded.
    subs.push({
      face: 'front',
      area_m2: frontArea,
      materialIdEmpty:  M_DOOR_F_E,
      materialIdLoaded: M_DOOR_F_L,
      fillBlend: true,
    });
    // REAR: perforated-steel door. Cavity behind it is the same rack
    // interior; Dr. Chen's spec uses a single α (empty assumption,
    // since the device fronts face FORWARD, not rearward). At our
    // fidelity tier, the rear door doesn't blend.
    subs.push({
      face: 'rear',
      area_m2: rearArea,
      materialIdEmpty:  M_DOOR_R,
      materialIdLoaded: M_DOOR_R,
      fillBlend: false,
    });
    // SIDES: solid painted steel. Two faces. Do NOT blend with fill —
    // panel impedance is the same hot or cold (Dr. Chen guardrail).
    subs.push({
      face: 'side_left',  area_m2: sideArea,
      materialIdEmpty: M_PANEL, materialIdLoaded: M_PANEL, fillBlend: false,
    });
    subs.push({
      face: 'side_right', area_m2: sideArea,
      materialIdEmpty: M_PANEL, materialIdLoaded: M_PANEL, fillBlend: false,
    });
    // TOP: vented (~vent_top_pct % open area). For now treat as one
    // material; vent percentage already baked into M_TOP_VENT's
    // ~40%-open α curve. Don't blend.
    subs.push({
      face: 'top', area_m2: topArea,
      materialIdEmpty: M_TOP_VENT, materialIdLoaded: M_TOP_VENT, fillBlend: false,
    });
    return subs;
  }

  // Open-frame, fillRatio > 0: only the chassis-array front face has
  // any acoustic surface (no doors, no sides, no top plate of
  // significant area). One sub-volume on the front, blended by fill.
  subs.push({
    face: 'front',
    area_m2: frontArea,
    // Empty face is literally absent; represent with the same loaded
    // material but rely on the (1−r) coefficient (which is 1 at r=0)
    // multiplying α_empty — but α_empty needs to be 0 here. Use the
    // chassis material for BOTH and let the blend short-circuit at
    // r=0 by also returning fillBlend=false IF r is exactly 0. But
    // we've already short-circuited above, so by here r > 0; blend
    // chassis vs chassis. To get a real (0 → chassis) ramp we encode
    // the "empty open-frame front is nothing" as fillBlend=true with
    // an UNRESOLVABLE material on the empty side; caller falls back
    // to α=0. Cleanest: a sentinel id.
    materialIdEmpty:  '__none__',
    materialIdLoaded: M_CHASSIS,
    fillBlend: true,
  });
  return subs;
}

/**
 * Per-band absorption from one rack at one frequency.
 * Returns m² Sabine. Resolves α from `materialAlphaAt(id, freq_hz)`
 * — caller supplies a closure so this module stays decoupled from the
 * materials catalogue shape.
 *
 * @param {object}   rack
 * @param {object}   rackDef
 * @param {(id:string, f:number)=>number} materialAlphaAt
 * @param {number}   frequency_hz
 * @returns {number} A_obj at this band (m² Sabine)
 */
export function rackAbsorptionAt(rack, rackDef, materialAlphaAt, frequency_hz) {
  if (typeof materialAlphaAt !== 'function') return 0;
  const subs = getRackSubVolumes(rack, rackDef);
  if (subs.length === 0) return 0;
  const r = rackFillRatio(rack, rackDef);
  let total = 0;
  for (const sub of subs) {
    let alpha;
    if (sub.fillBlend) {
      // '__none__' resolves to α=0 (the open-frame empty-side sentinel).
      const aE = sub.materialIdEmpty === '__none__' ? 0 : materialAlphaAt(sub.materialIdEmpty, frequency_hz);
      const aL = materialAlphaAt(sub.materialIdLoaded, frequency_hz);
      alpha = (1 - r) * (Number.isFinite(aE) ? aE : 0)
            +       r  * (Number.isFinite(aL) ? aL : 0);
    } else {
      const a = materialAlphaAt(sub.materialIdEmpty, frequency_hz);
      alpha = Number.isFinite(a) ? a : 0;
    }
    total += sub.area_m2 * Math.max(0, alpha);
  }
  return total;
}

/**
 * Sum A_obj across all placed racks at one octave band. Returns 0 when
 * the array is empty, the catalogue is missing, or no rack resolves.
 * Mirrors sumFurnitureAbsorption's contract from
 * js/physics/furniture-absorption.js.
 *
 * @param {Array}  racks               state.rackSystem.racks
 * @param {Map|object} rackCatalogue   either Map<key, def> or the
 *                                     raw {racks: {...}} JSON
 * @param {(id:string, f:number)=>number} materialAlphaAt
 * @param {number} frequency_hz
 * @returns {number} Σ A_obj (m² Sabine)
 */
export function sumRackAbsorption(racks, rackCatalogue, materialAlphaAt, frequency_hz) {
  if (!Array.isArray(racks) || racks.length === 0) return 0;
  if (!rackCatalogue || typeof materialAlphaAt !== 'function') return 0;
  // Accept either Map<key,def> OR the raw catalogue object {racks: {...}}.
  const lookup = typeof rackCatalogue.get === 'function'
    ? (k) => rackCatalogue.get(k)
    : (k) => rackCatalogue.racks?.[k] ?? null;
  let total = 0;
  for (const rack of racks) {
    if (!rack || typeof rack.rackModelKey !== 'string') continue;
    const def = lookup(rack.rackModelKey);
    if (!def) continue;
    total += rackAbsorptionAt(rack, def, materialAlphaAt, frequency_hz);
  }
  return total;
}
