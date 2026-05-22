// WallLAB mount module — Lab #5. Lazy-mounted by the SPA router on the
// first #/wall visit.
//
// Phase 1 (2026-05-22): the BETA toggle for over-wall acoustics (Tier 1a:
// Maekawa edge diffraction + Kuttruff wall re-radiation, default OFF) plus
// a placeholder for the wall-isolation simulator. The simulator proper
// (material + thickness → per-band transmission loss, with the live
// equation + standard cited) lands in Phases 2-3.
//
// Born from the surau azan-horn investigation: a horn mounted 2.5 m above
// a 4.5 m wall genuinely projects sound OVER the wall, which the Tier 1a
// physics models and the simplified deploy model does not. This LAB makes
// that physics inspectable + gives the user a real control for the flag,
// instead of it being a hidden localhost auto-enable.

import { mountWallSim } from './wall-sim.js';

let _mounted = false;

export async function mountWallLab() {
  if (_mounted) return;
  _mounted = true;
  mountWallSim();
}
