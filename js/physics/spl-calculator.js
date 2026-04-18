import { interpolateAttenuation } from './loudspeaker.js';

export function localAngles(speakerPos, speakerAimDeg, listenerPos) {
  const dx = listenerPos.x - speakerPos.x;
  const dy = listenerPos.y - speakerPos.y;
  const dz = listenerPos.z - speakerPos.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-6) return { r: 1e-6, azimuth_deg: 0, elevation_deg: 0 };

  const yaw_rad = speakerAimDeg.yaw * Math.PI / 180;
  const pitch_rad = speakerAimDeg.pitch * Math.PI / 180;

  const aimX = Math.sin(yaw_rad);
  const aimY = Math.cos(yaw_rad);
  const rightX = Math.cos(yaw_rad);
  const rightY = -Math.sin(yaw_rad);

  const dot_aim = dx * aimX + dy * aimY;
  const dot_right = dx * rightX + dy * rightY;
  const azimuth_rad = Math.atan2(dot_right, dot_aim);

  const horizDist = Math.sqrt(dx * dx + dy * dy);
  const listenerElev_rad = Math.atan2(dz, horizDist);
  const elevation_rad = listenerElev_rad - pitch_rad;

  return {
    r,
    azimuth_deg: azimuth_rad * 180 / Math.PI,
    elevation_deg: elevation_rad * 180 / Math.PI,
  };
}

export function computeDirectSPL({ speakerDef, speakerState, listenerPos, freq_hz = 1000 }) {
  const { r, azimuth_deg, elevation_deg } = localAngles(
    speakerState.position, speakerState.aim, listenerPos
  );
  const clampedR = Math.max(r, 0.1);
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  const attn = interpolateAttenuation(speakerDef.directivity, azimuth_deg, elevation_deg, freq_hz);
  const spl_db = sens + 10 * Math.log10(speakerState.power_watts) - 20 * Math.log10(clampedR) + attn;
  return { r, azimuth_deg, elevation_deg, attn_db: attn, spl_db };
}

export function computeSPLGrid({
  speakerDef, speakerState, room,
  earHeight_m = 1.2, gridSize = 25, freq_hz = 1000,
}) {
  const cellsX = gridSize;
  const cellsY = gridSize;
  const cellW_m = room.width_m / cellsX;
  const cellD_m = room.depth_m / cellsY;

  const grid = [];
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;

  for (let j = 0; j < cellsY; j++) {
    const row = [];
    for (let i = 0; i < cellsX; i++) {
      const x = (i + 0.5) * cellW_m;
      const y = (j + 0.5) * cellD_m;
      const { spl_db } = computeDirectSPL({
        speakerDef, speakerState,
        listenerPos: { x, y, z: earHeight_m },
        freq_hz,
      });
      row.push(spl_db);
      if (spl_db < minSPL) minSPL = spl_db;
      if (spl_db > maxSPL) maxSPL = spl_db;
      sum += spl_db;
      count++;
    }
    grid.push(row);
  }

  return {
    grid, cellsX, cellsY, cellW_m, cellD_m,
    minSPL_db: minSPL, maxSPL_db: maxSPL,
    avgSPL_db: sum / count, uniformity_db: maxSPL - minSPL,
    freq_hz, earHeight_m,
  };
}
