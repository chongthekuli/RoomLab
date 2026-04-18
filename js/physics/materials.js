export async function loadMaterials(url = 'data/materials.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const data = await res.json();
  return {
    frequency_bands_hz: data.frequency_bands_hz,
    list: data.materials,
    byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
  };
}

export function getAbsorption(materials, materialId, bandIndex) {
  return materials.byId[materialId]?.absorption[bandIndex] ?? 0;
}
