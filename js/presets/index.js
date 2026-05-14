// Preset registry — signature, fully-built scenes that load verbatim.
// `auditorium` (sports arena), `pavilion` (4-level mall) and `surau`
// (mosque prayer hall) are the three full-build presets; the smaller
// rooms (hi-fi, studio, classroom, etc.) live as parametric TEMPLATES
// in `js/templates/` and regenerate when the user changes dimensions.

import auditorium from './auditorium.js';
import pavilion   from './pavilion.js';
import surau      from './surau.js';

export const PRESETS = {
  auditorium,
  pavilion,
  surau,
};
