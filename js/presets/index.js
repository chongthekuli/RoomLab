// Preset registry. Add new rooms by creating a file in this folder
// and re-exporting it here under its key. `applyPresetToState()` in
// app-state.js uses this map to replace the scene in one swap.

import auditorium  from './auditorium.js';
import chamber     from './chamber.js';
import recitalhall from './recitalhall.js';
import rotunda     from './rotunda.js';
import octagon     from './octagon.js';
import hifi        from './hifi.js';
import classroom   from './classroom.js';
import livevenue   from './livevenue.js';
import studio      from './studio.js';
import pavilion    from './pavilion.js';

export const PRESETS = {
  auditorium,
  chamber,
  recitalhall,
  rotunda,
  octagon,
  hifi,
  classroom,
  livevenue,
  studio,
  pavilion,
};
