// SurfaceLAB catalogue loader — merges plain finishes from
// `data/materials.json` (inferred to surface.{hard,soft,wood}) with
// engineered products from `data/treatment-products.json` (already
// carry dotted-path categories per Dr. Chen's schema v2.0). Returns
// a unified browseable list grouped by **first segment** of the
// dotted path — that segment maps 1:1 to a left-rail icon in the
// SurfaceLAB navigation.
//
// Sofia + Dr. Chen taxonomy (Oct 2026):
//   surface.{hard, soft, wood}
//   absorber.porous.{panel, foam, curtain}
//   absorber.microperf
//   bass.{porous, membrane, helmholtz, tuned_array}
//   diffuser.{qrd_1d, qrd_2d, geometric, parametric, hybrid}
//   opening.{door, window, vent}
//   system.{partition, modular, active}
//
// The `ceiling` rail icon is a VIEW, not a storage class — it filters
// in any entry whose `mounting` starts with `ceiling_`. Decision made
// to avoid fragmenting mounting metadata between identical products
// mounted on a wall vs overhead.

import { runTrustFlagAudit } from './trust-flags.js';

// Rail navigation order — Sofia's "most-used first" arrangement.
const RAIL_ORDER = ['absorber', 'bass', 'diffuser', 'ceiling', 'surface', 'opening', 'system'];

const RAIL_LABELS = {
  absorber: 'Broadband absorbers',
  bass:     'Bass control',
  diffuser: 'Diffusers',
  ceiling:  'Ceiling (view)',
  surface:  'Surfaces & finishes',
  opening:  'Openings',
  system:   'Systems',
};

let _cached = null;

export async function loadSurfaceCatalogue() {
  if (_cached) return _cached;

  const [materials, products] = await Promise.all([
    fetch('./data/materials.json').then(r => r.json()),
    fetch('./data/treatment-products.json').then(r => r.json()),
  ]);

  // Plain materials → surface.{hard,soft,wood} or absorber.* /
  // bass.* / etc. inferred from the id pattern. Existing entries
  // with names like "bass-trap-broadband-corner" route correctly.
  const finishEntries = (materials.materials || []).map(m => {
    const category = inferCategoryFromId(m.id);
    return {
      id: m.id,
      name: m.name,
      manufacturer: m.manufacturer || 'Generic',
      category,
      description: m._source || '',
      absorption: m.absorption,
      scattering_coefficient: m.scattering,
      diffusion_d: null,
      geometry: { width_mm: 600, height_mm: 600, depth_mm: 10 },
      mounting: m.mounting || 'reference',
      test_standard: m._source ? 'ISO 354 / Beranek' : 'reference',
      test_lab: m._test_lab || null,
      test_report_id: m._test_report_id || null,
      nrc: m.nrc ?? null,
      fire_rating: null,
      price_tier: null,
      visual: m.visual || inferVisualFromId(m.id),
      _source: 'materials',
    };
  });

  const productEntries = (products.products || []).map(p => ({
    ...p,
    visual: p.visual || inferVisualFromCategory(p.category),
    _source: 'treatment-products',
  }));

  const all = [...finishEntries, ...productEntries].map(entry => ({
    ...entry,
    railSegment: railSegmentFor(entry.category),
    trust_flags: runTrustFlagAudit(entry),
  }));

  // Build per-rail groups. `ceiling` is special — it aliases over
  // entries from other rails whose mounting begins with `ceiling_`.
  const groups = RAIL_ORDER.map(seg => {
    let entries;
    if (seg === 'ceiling') {
      entries = all.filter(e => typeof e.mounting === 'string' && /^ceiling/i.test(e.mounting));
    } else {
      entries = all.filter(e => e.railSegment === seg);
    }
    return {
      id: seg,
      label: RAIL_LABELS[seg],
      entries: entries.sort((a, b) => {
        const mfr = (a.manufacturer || '').localeCompare(b.manufacturer || '');
        return mfr !== 0 ? mfr : (a.name || '').localeCompare(b.name || '');
      }),
    };
  });

  _cached = { all, groups };
  return _cached;
}

export function findCatalogueEntry(id) {
  if (!_cached) return null;
  return _cached.all.find(e => e.id === id) || null;
}

export function railSegmentFor(category) {
  if (!category || typeof category !== 'string') return 'surface';
  return category.split('.')[0];
}

// Map free-form material id strings to dotted-path categories. Used
// only for the legacy materials.json entries; treatment-products.json
// supplies category fields directly.
function inferCategoryFromId(id) {
  if (/membrane|helmholtz/i.test(id))            return 'bass.membrane';
  if (/^bass.?trap|^broadband.?bass/i.test(id))  return 'bass.porous';
  if (/^broadband|panel.?absorb|rockwool|fibreglass/i.test(id)) return 'absorber.porous.panel';
  if (/foam.*(wedge|pyramid)/i.test(id))         return 'absorber.porous.foam';
  if (/qrd|skyline|diffractal/i.test(id))        return 'diffuser.qrd_1d';
  if (/polycyl/i.test(id))                       return 'diffuser.geometric';
  if (/ceiling.?tile|suspended|baffle|cloud/i.test(id)) return 'absorber.porous.panel';
  if (/curtain|drape/i.test(id))                 return 'absorber.porous.curtain';
  if (/door/i.test(id))                          return 'opening.door';
  if (/window|glazing/i.test(id))                return 'opening.window';
  if (/carpet|vinyl/i.test(id))                  return 'surface.soft';
  if (/wood|timber|veneer|panel.?wood/i.test(id)) return 'surface.wood';
  // Default: hard surface (concrete, gypsum, brick, plaster, glass, paint, metal, etc.)
  return 'surface.hard';
}

function inferVisualFromId(id) {
  const v = (color, roughness = 0.85, metalness = 0.0, pattern = null) => ({ color, roughness, metalness, pattern });
  if (/concrete/.test(id))        return v('#bdb6a8', 0.92);
  if (/brick/.test(id))           return v('#8a4a3a', 0.95, 0, 'brick');
  if (/gypsum|drywall|plaster/.test(id)) return v('#ece8df', 0.88);
  if (/glass|window/.test(id))    return v('#9fd1e6', 0.05, 0.0);
  if (/wood/.test(id))            return v('#8a6a40', 0.78, 0.0, 'wood');
  if (/carpet/.test(id))          return v('#5a4a3a', 0.98, 0.0, 'carpet');
  if (/marble|tile|polished/.test(id)) return v('#cfd0cf', 0.30, 0.10);
  if (/fabric|curtain/.test(id))  return v('#6a5a4a', 0.95, 0.0, 'fabric');
  if (/metal|steel|aluminium|aluminum/.test(id)) return v('#9aa0a8', 0.45, 0.85);
  return v('#9a9590', 0.85);
}

function inferVisualFromCategory(category) {
  const seg = railSegmentFor(category);
  switch (seg) {
    case 'diffuser':    return { color: '#b69b6e', roughness: 0.65, metalness: 0.05 };
    case 'absorber':    return { color: '#3d3a36', roughness: 0.92, metalness: 0.0, pattern: 'fabric' };
    case 'bass':        return { color: '#3d3a36', roughness: 0.95, metalness: 0.0, pattern: 'fabric' };
    case 'opening':     return { color: '#7a6a5a', roughness: 0.55, metalness: 0.1, pattern: 'wood' };
    case 'system':      return { color: '#9aa0a8', roughness: 0.6, metalness: 0.3 };
    default:            return { color: '#9a9590', roughness: 0.85 };
  }
}
