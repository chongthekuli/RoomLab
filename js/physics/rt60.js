const SABINE_CONSTANT = 0.161;

export function sabine({ volume_m3, totalAbsorption_sabins }) {
  if (totalAbsorption_sabins <= 0) return Infinity;
  return SABINE_CONSTANT * volume_m3 / totalAbsorption_sabins;
}

export function eyring({ volume_m3, totalArea_m2, meanAbsorption }) {
  if (meanAbsorption <= 0) return Infinity;
  if (meanAbsorption >= 1) return 0;
  return SABINE_CONSTANT * volume_m3 / (-totalArea_m2 * Math.log(1 - meanAbsorption));
}

function shoeboxSurfaces(room) {
  const { width_m: w, height_m: h, depth_m: d, surfaces } = room;
  return [
    { id: 'floor',      area_m2: w * d, materialId: surfaces.floor },
    { id: 'ceiling',    area_m2: w * d, materialId: surfaces.ceiling },
    { id: 'wall_north', area_m2: w * h, materialId: surfaces.wall_north },
    { id: 'wall_south', area_m2: w * h, materialId: surfaces.wall_south },
    { id: 'wall_east',  area_m2: d * h, materialId: surfaces.wall_east },
    { id: 'wall_west',  area_m2: d * h, materialId: surfaces.wall_west },
  ];
}

export function computeRT60Band({ room, materials, bandIndex }) {
  const surfaces = shoeboxSurfaces(room);
  let totalArea_m2 = 0;
  let totalAbsorption_sabins = 0;
  for (const s of surfaces) {
    const alpha = materials.byId[s.materialId]?.absorption[bandIndex] ?? 0;
    totalArea_m2 += s.area_m2;
    totalAbsorption_sabins += s.area_m2 * alpha;
  }
  const volume_m3 = room.width_m * room.height_m * room.depth_m;
  const meanAbsorption = totalArea_m2 > 0 ? totalAbsorption_sabins / totalArea_m2 : 0;
  return {
    volume_m3,
    totalArea_m2,
    totalAbsorption_sabins,
    meanAbsorption,
    sabine_s: sabine({ volume_m3, totalAbsorption_sabins }),
    eyring_s: eyring({ volume_m3, totalArea_m2, meanAbsorption }),
  };
}

export function computeAllBands({ room, materials }) {
  return materials.frequency_bands_hz.map((frequency_hz, i) => ({
    frequency_hz,
    ...computeRT60Band({ room, materials, bandIndex: i }),
  }));
}
