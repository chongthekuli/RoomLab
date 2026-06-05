// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Per-listener SPL + STI used by the live 2D viewport and the print
// report's plan / heatmap pages. SPL is the same total computed by the
// listener-results panel (1 kHz, sources + reverb leak per physics
// settings). STI is read from the precision-engine result when one
// exists; null when the user hasn't kicked off a precision render.
//
// Output shape — array indexed in state.listeners order:
//   [{ spl_db: number|null, sti: number|null }, ...]
//
// Pure on its inputs; safe to call on every render (only one
// computeMultiSourceSPL per listener — N sources × N listeners — cheaper
// than the splGrid we already build).

import { earHeightFor, expandSources } from './source-expand.js';
import { computeMultiSourceSPL, computeRoomConstant } from './spl-calculator.js';
import { getCachedLoudspeaker } from './loudspeaker.js';
import { deriveMetrics } from './precision/derive-metrics.js';
import { getFurnitureCatalogue, getRackCatalogue, getStructureMaterialCatalogue } from './providers.js';
import { computeRT60Band, preferredRT60 } from './rt60.js';
import { bandIndexForFreq } from './wall-path.js';
import { roomVolume } from './room-shape.js';
import { schroederFrequency } from './schroeder.js';
import { computeModalField, crossfadeWeight } from './modal-field.js';

export function computePerListenerMetrics(state, materials) {
  const listeners = state.listeners ?? [];
  if (listeners.length === 0) return [];

  const phys = state.physics ?? {};
  const freq = phys.freq_hz ?? 1000;
  const flatSources = expandSources(state.sources ?? []);
  const roomConstantR = (phys.reverberantField && materials)
    ? computeRoomConstant(state.room, materials, freq, state.zones, {
        treatments: state.treatments,
        furniture: state.furniture,
        furnitureCatalogue: getFurnitureCatalogue(),
        racks: state.rackSystem?.racks ?? [],
        rackCatalogue: getRackCatalogue(),
        structures: state.structures,
      })
    : 0;

  // --- Low-frequency MODAL context (Dr. Chen spec, 2026-06-05) ----------
  // Below the Schroeder frequency the per-listener SPL must reflect the modal
  // standing-wave field — a listener near a wall/corner reads HIGHER bass than
  // one mid-room at the same source distance. We reuse the SAME analytic modal
  // field + analytic-volume-mean normalisation the heatmap uses, so the dot and
  // the heatmap agree by construction. Gated identically: indoor rectangular
  // room, reverb on, below ~1.5·f_s. Computed ONCE (constant across listeners).
  let modalCtx = null;
  if (roomConstantR > 0 && materials?.frequency_bands_hz && state.room?.shape === 'rectangular') {
    const V = roomVolume(state.room);
    const bandIdx = bandIndexForFreq(materials, freq);
    const rt = computeRT60Band({
      room: state.room, materials, bandIndex: bandIdx, zones: state.zones,
      treatments: state.treatments, furniture: state.furniture,
      furnitureCatalogue: getFurnitureCatalogue(), racks: state.rackSystem?.racks ?? [],
      rackCatalogue: getRackCatalogue(), structures: state.structures,
      airAbsorption: phys.airAbsorption !== false,
    });
    const t60_s = preferredRT60(rt);
    const f_s = schroederFrequency(t60_s, V);
    const w = crossfadeWeight(freq, f_s);
    if (f_s > 0 && w > 0 && t60_s > 0) modalCtx = { t60_s, f_s, weight: w };
  }

  // STI lookup — only populated when a precision render exists. Reuses
  // the same deriveMetrics() the precision panel uses so the value on
  // the dot matches the value in the table to two decimals.
  const stiByIdx = new Map();
  const precision = state.results?.precision;
  if (precision && typeof precision === 'object') {
    try {
      const metrics = deriveMetrics(precision, {
        ambientNoise_per_band: phys.ambientNoise?.per_band,
      });
      if (Array.isArray(metrics)) {
        metrics.forEach((m, idx) => {
          if (Number.isFinite(m?.sti?.sti)) stiByIdx.set(idx, m.sti.sti);
        });
      }
    } catch (err) {
      console.warn('[per-listener-metrics] deriveMetrics failed:', err);
    }
  }

  return listeners.map((lst, idx) => {
    let spl_db = null;
    if (flatSources.length > 0) {
      try {
        const ear = earHeightFor(lst);
        const listenerPos = { x: lst.position.x, y: lst.position.y, z: ear };
        const splOpts = {
          sources: flatSources,
          getSpeakerDef: url => getCachedLoudspeaker(url),
          listenerPos,
          freq_hz: freq,
          room: state.room,
          materials,
          airAbsorption: phys.airAbsorption !== false,
          coherent: !!phys.coherent,
          roomConstantR,
          furniture: state.furniture,
          furnitureCatalogue: getFurnitureCatalogue(),
          racks: state.rackSystem?.racks ?? [],
          rackCatalogue: getRackCatalogue(),
          structures: state.structures,
          structureMaterials: getStructureMaterialCatalogue(),
        };
        const v = computeMultiSourceSPL(splOpts);
        if (Number.isFinite(v)) spl_db = v;

        // --- Modal redistribution at this point (Dr. Chen §1d-1e) -------
        // The statistical SPL `v` is direct ⊕ a spatially-FLAT reverberant
        // term. Below f_s, replace that reverberant term with the modal
        // field evaluated AT this point, anchored so its analytic volume-
        // mean equals the statistical reverberant energy (energy-conserving,
        // continuous at f_s). Direct field is untouched (it propagates 1/r²
        // regardless of band). This makes a near-wall/corner listener read
        // the real boundary bass while a mid-room listener reads the null.
        if (modalCtx && Number.isFinite(v)) {
          // Split: direct-only is the same scene with the reverberant field off.
          const vDirect = computeMultiSourceSPL({ ...splOpts, roomConstantR: 0 });
          if (Number.isFinite(vDirect)) {
            const eTotal = Math.pow(10, v / 10);
            const eDirect = Math.pow(10, vDirect / 10);
            const eRevStat = Math.max(0, eTotal - eDirect);   // statistical reverberant energy
            if (eRevStat > 0) {
              const modalSources = flatSources.map(s => ({
                x: s.position?.x, y: s.position?.y, z: s.position?.z ?? ear,
                weight: Number.isFinite(s.power_watts) ? s.power_watts : 1,
              }));
              const modal = computeModalField({
                room: state.room, sources: modalSources, freq_hz: freq,
                t60_s: modalCtx.t60_s, f_s: modalCtx.f_s,
                cells: [{ x: listenerPos.x, y: listenerPos.y }], earZ: ear,
              });
              if (modal && modal.analyticMean > 0) {
                const Gr = modal.p2[0];
                const eModal = eRevStat * (Gr / modal.analyticMean);   // absolute via the analytic anchor
                const w = modalCtx.weight;
                const eRevBlend = (1 - w) * eRevStat + w * eModal;
                const eFinal = eDirect + eRevBlend;
                if (eFinal > 0) spl_db = 10 * Math.log10(eFinal);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[per-listener-metrics] SPL failed for', lst.id, err);
      }
    }
    return { spl_db, sti: stiByIdx.get(idx) ?? null };
  });
}

// Compact "82 · 0.55" / "82 dB" / "STI 0.55" label, or '' when neither
// metric is available. Used by both the live 2D viewport and the print
// SVGs so the formatting stays identical.
export function formatListenerMetricsLabel({ spl_db, sti }, { withUnits = true } = {}) {
  const parts = [];
  if (Number.isFinite(spl_db)) parts.push(withUnits ? `${spl_db.toFixed(0)} dB` : spl_db.toFixed(0));
  if (Number.isFinite(sti)) parts.push(withUnits ? `STI ${sti.toFixed(2)}` : sti.toFixed(2));
  return parts.join(' · ');
}
