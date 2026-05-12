// Single source of truth for "wipe the scene clean" — the reset that
// EVERY scene-replacement code path must call.
//
// Background: the auditorium → pavilion crossover bug, the
// pavilion-zones-survived-template-apply bug, and the recent custom-
// room-still-shows-arena-audience bug all had the same shape — a
// scene-replacement entry point cleared SOME state fields but missed
// others, and the missed ones bled across the swap. Each entry point
// (applyPresetToState, applyTemplateToState, applyBlankCustomRoom,
// deserializeProject) was doing its reset slightly differently and
// drifting from the others as fields were added.
//
// This module is the canonical implementation. Every entry point
// imports `resetSceneState()` and calls it before applying its own
// per-scene content. New state fields added here automatically flow
// through every reset path — no more "did we clear that field in
// THIS function too?" maintenance burden.

// Reset every state.* field that holds scene content. Optional
// `projectName` lets the caller preserve a name (e.g. user just
// typed "Hospital Serdang" before triggering a blank-custom-room).
//
// `state`, `defaultRoomState`, and `deepClone` are passed in so this
// module can stay free of circular-import risk against app-state.js.
//
// What this clears:
//   - state.room → defaultRoomState
//   - state.zones, state.sources, state.listeners → []
//   - state.selectedZoneId / selectedListenerId / selectedSpeakerUrl → null
//   - state.rackSystem.racks → []
//   - state.projectName → null (or argument)
//   - state.results.* → null/empty (heatmap grids, precision render)
//   - state.results.engines.precision.* → reset
//
// What this does NOT clear (out of scope):
//   - state.physics (EQ, ambient noise — user-tuned, persists)
//   - state.display (UI toggles — user preferences, persist)
//
// Caller emits `scene:reset` after applying their per-scene content
// so subscribed panels + the 3D viewport can rebuild against the new
// state.
export function resetSceneState({ state, defaultRoomState, deepClone, projectName = null } = {}) {
  if (!state) throw new Error('resetSceneState: state is required');
  if (!defaultRoomState) throw new Error('resetSceneState: defaultRoomState is required');
  if (typeof deepClone !== 'function') throw new Error('resetSceneState: deepClone is required');

  Object.assign(state.room, deepClone(defaultRoomState));

  state.zones     = [];
  state.sources   = [];
  state.listeners = [];
  state.selectedZoneId     = null;
  state.selectedListenerId = null;
  state.selectedSpeakerUrl = null;
  // Sub-structure selection — visual click-to-select on placed sub-rooms
  // (see js/graphics/scene.js onSubStructureClick). Reset here so a swap
  // never leaves the chip row in panel-room.js highlighting a sub from
  // the previous scene.
  state.selectedSubStructureId = null;
  state.selectedSurfaceId = null;
  state.selectedSourceIdx = null;

  state.rackSystem = { racks: [] };
  state.projectName = projectName;

  if (state.results) {
    state.results.splGrid   = null;
    state.results.zoneGrids = [];
    state.results.precision = null;
    if (state.results.engines?.precision) {
      state.results.engines.precision.lastRun    = null;
      state.results.engines.precision.staleAt    = null;
      state.results.engines.precision.inProgress = false;
    }
  }
}
