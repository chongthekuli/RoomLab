const cache = new Map();

export async function loadLoudspeaker(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const def = await res.json();
  cache.set(url, def);
  return def;
}

export function getCachedLoudspeaker(url) {
  return cache.get(url);
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
