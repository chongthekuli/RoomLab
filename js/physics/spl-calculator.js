import { interpolateAttenuation } from './loudspeaker.js';
import { isInsideRoom3D } from './room-shape.js';

export const WALL_TRANSMISSION_LOSS_DB = 30;

function pathCrossesBoundary(speakerState, listenerPos, room) {
  if (!room) return false;
  const sIn = isInsideRoom3D(speakerState.position, room);
  const lIn = isInsideRoom3D(listenerPos, room);
  return sIn !== lIn;
}

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

export function computeDirectSPL({ speakerDef, speakerState, listenerPos, freq_hz = 1000, room = null }) {
  const { r, azimuth_deg, elevation_deg } = localAngles(
    speakerState.position, speakerState.aim, listenerPos
  );
  const clampedR = Math.max(r, 0.1);
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  const attn = interpolateAttenuation(speakerDef.directivity, azimuth_deg, elevation_deg, freq_hz);
  let spl_db = sens + 10 * Math.log10(speakerState.power_watts) - 20 * Math.log10(clampedR) + attn;
  const through_wall = pathCrossesBoundary(speakerState, listenerPos, room);
  if (through_wall) spl_db -= WALL_TRANSMISSION_LOSS_DB;
  return { r, azimuth_deg, elevation_deg, attn_db: attn, spl_db, through_wall };
}

export function computeMultiSourceSPL({ sources, getSpeakerDef, listenerPos, freq_hz = 1000, room = null }) {
  let pressureSum = 0;
  for (const src of sources) {
    const def = getSpeakerDef(src.modelUrl);
    if (!def) continue;
    const { spl_db } = computeDirectSPL({
      speakerDef: def, speakerState: src, listenerPos, freq_hz, room,
    });
    pressureSum += Math.pow(10, spl_db / 10);
  }
  return pressureSum > 0 ? 10 * Math.log10(pressureSum) : -Infinity;
}

export function computeListenerBreakdown({ sources, getSpeakerDef, listenerPos, freq_hz = 1000, room = null }) {
  const perSpeaker = sources.map((src, i) => {
    const def = getSpeakerDef(src.modelUrl);
    const outsideRoom = room ? !isInsideRoom3D(src.position, room) : false;
    if (!def) return { idx: i, spl_db: -Infinity, r: null, azimuth_deg: null, modelUrl: src.modelUrl, outsideRoom, through_wall: false };
    const d = computeDirectSPL({ speakerDef: def, speakerState: src, listenerPos, freq_hz, room });
    return { idx: i, spl_db: d.spl_db, r: d.r, azimuth_deg: d.azimuth_deg, modelUrl: src.modelUrl, outsideRoom, through_wall: d.through_wall };
  });
  let pressureSum = 0;
  for (const p of perSpeaker) if (isFinite(p.spl_db)) pressureSum += Math.pow(10, p.spl_db / 10);
  const total_spl_db = pressureSum > 0 ? 10 * Math.log10(pressureSum) : -Infinity;
  return { perSpeaker, total_spl_db, freq_hz };
}

function pointInPoly(x, y, verts) {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (((verts[i].y > y) !== (verts[j].y > y)) &&
        (x < (verts[j].x - verts[i].x) * (y - verts[i].y) / (verts[j].y - verts[i].y) + verts[i].x)) {
      inside = !inside;
    }
  }
  return inside;
}

export function computeZoneSPLGrid({
  zone, sources, getSpeakerDef, room,
  gridSize = 22, freq_hz = 1000, earAbove_m = 1.2,
}) {
  const verts = zone.vertices || [];
  if (verts.length < 3) return null;
  const xs = verts.map(v => v.x), ys = verts.map(v => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cellW = (maxX - minX) / gridSize;
  const cellH = (maxY - minY) / gridSize;
  const grid = [];
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;
  const earZ = (zone.elevation_m || 0) + earAbove_m;
  for (let j = 0; j < gridSize; j++) {
    const row = [];
    for (let i = 0; i < gridSize; i++) {
      const x = minX + (i + 0.5) * cellW;
      const y = minY + (j + 0.5) * cellH;
      if (!pointInPoly(x, y, verts)) { row.push(-Infinity); continue; }
      const listenerPos = { x, y, z: earZ };
      const spl = computeMultiSourceSPL({ sources, getSpeakerDef, listenerPos, freq_hz, room });
      row.push(spl);
      if (isFinite(spl)) {
        if (spl < minSPL) minSPL = spl;
        if (spl > maxSPL) maxSPL = spl;
        sum += spl;
        count++;
      }
    }
    grid.push(row);
  }
  const ok = count > 0;
  return {
    id: zone.id, label: zone.label,
    grid, cellsX: gridSize, cellsY: gridSize,
    boundsX: [minX, maxX], boundsY: [minY, maxY],
    cellW_m: cellW, cellH_m: cellH,
    elevation_m: zone.elevation_m || 0,
    earZ_m: earZ,
    minSPL_db: ok ? minSPL : 0,
    maxSPL_db: ok ? maxSPL : 0,
    avgSPL_db: ok ? sum / count : 0,
    uniformity_db: ok ? (maxSPL - minSPL) : 0,
  };
}

export function computeSPLGrid({
  sources, getSpeakerDef, room,
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
      const listenerPos = { x, y, z: earHeight_m };
      if (!isInsideRoom3D(listenerPos, room)) {
        row.push(-Infinity);
        continue;
      }
      const totalSPL = computeMultiSourceSPL({ sources, getSpeakerDef, listenerPos, freq_hz, room });
      row.push(totalSPL);
      if (isFinite(totalSPL)) {
        if (totalSPL < minSPL) minSPL = totalSPL;
        if (totalSPL > maxSPL) maxSPL = totalSPL;
        sum += totalSPL;
        count++;
      }
    }
    grid.push(row);
  }

  const hasResults = count > 0;
  return {
    grid, cellsX, cellsY, cellW_m, cellD_m,
    minSPL_db: hasResults ? minSPL : 0,
    maxSPL_db: hasResults ? maxSPL : 0,
    avgSPL_db: hasResults ? sum / count : 0,
    uniformity_db: hasResults ? (maxSPL - minSPL) : 0,
    freq_hz, earHeight_m,
    sourceCount: sources.length,
  };
}
