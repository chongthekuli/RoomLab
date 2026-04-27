// Template registry — adjustable parametric room shapes the user picks
// as a starting point, then customises (dimensions, materials, sources).
// Different from PRESETS (signature pre-built scenes) in that templates
// regenerate sources/listeners every time dimensions change so the
// layout scales with the room.

import hifi        from './hifi.js';
import studio      from './studio.js';
import classroom   from './classroom.js';
import livevenue   from './livevenue.js';
import recitalhall from './recitalhall.js';
import chamber     from './chamber.js';
import octagon     from './octagon.js';
import rotunda     from './rotunda.js';

export const TEMPLATES = {
  hifi,
  studio,
  classroom,
  livevenue,
  recitalhall,
  chamber,
  octagon,
  rotunda,
};
