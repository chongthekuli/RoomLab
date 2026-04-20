const cache = new Map();

// Frequency-dependent pattern-widening multipliers for cabinets where
// only a single reference band is measured. Real cabinets narrow with
// frequency (beaming) and widen at LF (omni-like). Different classes
// behave differently — a horn keeps its pattern far better than a
// cone-only box, so we pick factors based on `directivity.class_hint`
// in the JSON (defaults to 'standard').
const PATTERN_CLASS_FACTORS = {
  standard: {
    125:  0.30,
    250:  0.60,
    500:  0.82,
    1000: 1.00,
    2000: 1.12,
    4000: 1.32,
    8000: 1.60,
  },
  horn: {  // waveguide-loaded — pattern well-controlled across the band
    125:  0.45,
    250:  0.75,
    500:  0.92,
    1000: 1.00,
    2000: 1.05,
    4000: 1.12,
    8000: 1.25,
  },
  'line-element': {  // narrow V always, some H shaping with frequency
    125:  0.35,
    250:  0.65,
    500:  0.88,
    1000: 1.00,
    2000: 1.08,
    4000: 1.22,
    8000: 1.45,
  },
};

// Clone the reference band (1 kHz when present, otherwise the lowest
// available frequency) to every missing band with the class multiplier
// applied. Preserves any explicit per-band data already in the file.
function fillMissingDirectivityBands(def) {
  const dir = def?.directivity;
  if (!dir?.attenuation_db) return;
  const bands = Object.keys(dir.attenuation_db);
  const refBand = '1000' in dir.attenuation_db
    ? '1000'
    : bands.sort((a, b) => Number(a) - Number(b))[0];
  if (!refBand) return;
  const ref = dir.attenuation_db[refBand];
  const factors = PATTERN_CLASS_FACTORS[dir.class_hint] || PATTERN_CLASS_FACTORS.standard;
  const allBands = def?.acoustic?.frequency_bands_hz ?? [125, 250, 500, 1000, 2000, 4000, 8000];
  for (const f of allBands) {
    const key = String(f);
    if (dir.attenuation_db[key]) continue;  // preserve explicit data
    const k = factors[f] ?? 1;
    dir.attenuation_db[key] = ref.map(row => row.map(v => v * k));
  }
}

export async function loadLoudspeaker(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const def = await res.json();
  fillMissingDirectivityBands(def);
  cache.set(url, def);
  return def;
}

export function getCachedLoudspeaker(url) {
  return cache.get(url);
}

// Register an in-memory loudspeaker definition under a synthetic URL so
// the rest of the app (heatmap + STIPA + precision) can resolve it with
// the same getCachedLoudspeaker call path as disk-loaded files. Used for
// user-imported CLF / JSON / XML speaker files.
export function registerLoudspeaker(url, def) {
  fillMissingDirectivityBands(def);
  cache.set(url, def);
}

export function interpolateAttenuation(directivity, azimuth_deg, elevation_deg, freq_hz) {
  const grid = directivity.attenuation_db[String(freq_hz)];
  if (!grid) return 0;

  const azs = directivity.azimuth_deg;
  const els = directivity.elevation_deg;

  const az = Math.max(azs[0], Math.min(azs[azs.length - 1], azimuth_deg));
  const el = Math.max(els[0], Math.min(els[els.length - 1], elevation_deg));

  let i0 = 0;
  while (i0 < azs.length - 2 && azs[i0 + 1] < az) i0++;
  const i1 = Math.min(i0 + 1, azs.length - 1);

  let j0 = 0;
  while (j0 < els.length - 2 && els[j0 + 1] < el) j0++;
  const j1 = Math.min(j0 + 1, els.length - 1);

  const tAz = azs[i1] === azs[i0] ? 0 : (az - azs[i0]) / (azs[i1] - azs[i0]);
  const tEl = els[j1] === els[j0] ? 0 : (el - els[j0]) / (els[j1] - els[j0]);

  const v00 = grid[j0][i0];
  const v01 = grid[j0][i1];
  const v10 = grid[j1][i0];
  const v11 = grid[j1][i1];

  return (1 - tEl) * ((1 - tAz) * v00 + tAz * v01) + tEl * ((1 - tAz) * v10 + tAz * v11);
}
