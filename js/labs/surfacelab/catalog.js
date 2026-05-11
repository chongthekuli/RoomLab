// SurfaceLAB catalogue loader — merges the existing `data/materials.json`
// (plain finishes: gypsum, brick, carpet, wood, etc.) with the new
// `data/treatment-products.json` (engineered diffusers, absorbers,
// bass traps from RPG / Auralex / GIK / Vicoustic / Primacoustic) into
// one unified browseable list, grouped by Sofia's primary axis:
//
//   1. Surfaces & finishes  — plain materials from materials.json
//   2. Broadband absorbers  — fabric-wrapped panels, foam panels
//   3. Bass traps           — corner traps, membrane traps, Helmholtz
//   4. Diffusers            — 1D QRD, 2D skyline, polycylindrical, hybrids
//   5. Ceiling systems      — drop tiles, suspended baffles, clouds
//
// Each entry is normalised to a single shape so the renderer doesn't
// have to switch on data source. The `category` field drives grouping;
// `kind` drives 3D-preview geometry + spec-card layout.

import { runTrustFlagAudit } from './trust-flags.js';

const CATEGORY_ORDER = ['finish', 'absorber', 'trap', 'diffuser', 'ceiling'];
const CATEGORY_LABELS = {
  finish:   'Surfaces & finishes',
  absorber: 'Broadband absorbers',
  trap:     'Bass traps',
  diffuser: 'Diffusers',
  ceiling:  'Ceiling systems',
};

let _cached = null;

export async function loadSurfaceCatalogue() {
  if (_cached) return _cached;

  const [materials, products] = await Promise.all([
    fetch('./data/materials.json').then(r => r.json()),
    fetch('./data/treatment-products.json').then(r => r.json()),
  ]);

  // Normalise plain materials to the unified shape. Default category:
  // 'finish' for everything except entries whose existing id starts
  // with 'bass-trap-' or 'broadband-' (those get re-categorised so
  // the bass-trap-broadband-corner that's already in materials.json
  // doesn't end up under "finishes").
  const finishEntries = (materials.materials || []).map(m => {
    const inferredCategory = inferCategoryFromId(m.id);
    return {
      id: m.id,
      name: m.name,
      manufacturer: m.manufacturer || 'Generic',
      kind: m.kind || (inferredCategory === 'finish' ? 'finish' : 'absorber_legacy'),
      category: inferredCategory,
      description: m._source || '',
      absorption: m.absorption,
      scattering: m.scattering,
      diffusion_d: null,
      geometry: { shape: 'sample_panel', width_mm: 600, height_mm: 600, depth_mm: 10 },
      mounting: m.mounting || 'ASTM_C423_TypeA',
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
    visual: p.visual || inferVisualFromKind(p.kind),
    _source: 'treatment-products',
  }));

  const all = [...finishEntries, ...productEntries].map(entry => ({
    ...entry,
    trust_flags: runTrustFlagAudit(entry),
  }));

  // Group by category, preserving CATEGORY_ORDER for stable section
  // ordering. Within each section, sort by manufacturer then name.
  const groups = CATEGORY_ORDER.map(cat => ({
    id: cat,
    label: CATEGORY_LABELS[cat],
    entries: all.filter(e => e.category === cat).sort((a, b) => {
      const mfr = (a.manufacturer || '').localeCompare(b.manufacturer || '');
      return mfr !== 0 ? mfr : (a.name || '').localeCompare(b.name || '');
    }),
  })).filter(g => g.entries.length > 0);

  _cached = { all, groups };
  return _cached;
}

export function findCatalogueEntry(id) {
  if (!_cached) return null;
  return _cached.all.find(e => e.id === id) || null;
}

function inferCategoryFromId(id) {
  if (/bass.?trap|membrane|helmholtz/i.test(id)) return 'trap';
  if (/^broadband|absorber|panel.*absorb|fibreglass|rockwool/i.test(id)) return 'absorber';
  if (/qrd|diffuser|skyline|diffractal|polycyl/i.test(id)) return 'diffuser';
  if (/ceiling.?tile|suspended|baffle|cloud/i.test(id)) return 'ceiling';
  return 'finish';
}

// Visual descriptor used by the 3D preview to colour the textured
// sample panel for plain finishes. Conservative palette pulled from
// real-world building-material samples; not photorealistic but
// recognisable across a 7-category catalogue.
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

function inferVisualFromKind(kind) {
  // Treatment products get geometry rather than texture, so the visual
  // is mostly fallback colour for the procedural mesh.
  switch (kind) {
    case 'diffuser_qrd_1d':
    case 'diffuser_skyline':
    case 'diffuser_poly':
    case 'hybrid_diffsorber':   return { color: '#b69b6e', roughness: 0.65, metalness: 0.05 };
    case 'absorber_foam_wedge':
    case 'absorber_foam_pyramid': return { color: '#7a7570', roughness: 0.95, metalness: 0.0 };
    case 'absorber_panel':      return { color: '#3d3a36', roughness: 0.92, metalness: 0.0, pattern: 'fabric' };
    case 'trap_corner_porous':  return { color: '#3d3a36', roughness: 0.95, metalness: 0.0, pattern: 'fabric' };
    case 'trap_membrane':       return { color: '#5a5550', roughness: 0.40, metalness: 0.10 };
    case 'ceiling_tile':        return { color: '#e8e6df', roughness: 0.92, metalness: 0.0 };
    default:                    return { color: '#888', roughness: 0.85 };
  }
}
