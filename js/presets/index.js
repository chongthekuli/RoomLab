// Preset registry — signature, fully-built scenes that load verbatim.
// `auditorium` (sports arena) and `pavilion` (4-level mall) are the only
// two; the eight smaller rooms (hi-fi, studio, classroom, etc.) live as
// parametric TEMPLATES in `js/templates/` and regenerate when the user
// changes their dimensions.

import auditorium from './auditorium.js';
import pavilion   from './pavilion.js';

export const PRESETS = {
  auditorium,
  pavilion,
};
