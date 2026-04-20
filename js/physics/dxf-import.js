// Minimal ASCII DXF importer for room outlines.
//
// Scope — extracts closed polygons usable as state.room.custom_vertices:
//   * LWPOLYLINE entities (the modern, common case)
//   * Legacy POLYLINE + VERTEX sequences
//   * Bulge factors converted to arc-segment samples (4 segments per arc)
//   * Unit conversion via $INSUNITS header (mm/cm/m/in/ft → m)
//
// Out of scope for v1 — and flagged to caller:
//   * LINE / ARC / SPLINE entities that aren't already inside a polyline
//   * Nested BLOCKs with INSERT transforms
//   * Binary DXF (we only accept ASCII — which is what every CAD tool
//     defaults to when you Save As / Export → .dxf)
//   * DWG (proprietary binary; convert to DXF in AutoCAD / LibreCAD first)
//
// Returned on success:
//   { polygons: [{ vertices: [{x,y}], closed: bool, area_m2: number,
//                  layer: string }], units: 'm', source_units: string,
//     bestIndex: number }
//
// On unrecoverable failure throws Error with a human-readable message.

const INSUNITS_TO_METERS = {
  0: 1,                   // unspecified — assume meters
  1: 0.0254,              // inches
  2: 0.3048,              // feet
  3: 1609.344,            // miles (nobody draws rooms in miles, but complete)
  4: 0.001,               // millimeters
  5: 0.01,                // centimeters
  6: 1,                   // meters
  7: 1000,                // kilometers
  8: 0.0000000254,        // microinches
  9: 0.0000254,           // mils
  10: 0.9144,             // yards
  11: 1e-10,              // angstroms
  12: 1e-9,               // nanometers
  13: 1e-6,               // microns
  14: 0.1,                // decimeters
  15: 10,                 // decameters
  16: 100,                // hectometers
  17: 1e9,                // gigameters
  18: 1.495978707e11,     // astronomical units
  19: 9.46073047258e15,   // light years
  20: 3.08567758149e16,   // parsecs
  21: 0.3048006096012192, // US Survey feet
  22: 0.0254000508001016, // US Survey inches
  23: 0.9144018288036576, // US Survey yards
  24: 1609.347218694437,  // US Survey miles
};

const UNIT_LABEL = {
  0: 'unspecified', 1: 'inches', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'meters',
};

export async function importDxfFile(file) {
  const name = (file?.name ?? '').toLowerCase();
  if (name.endsWith('.dwg')) {
    throw new Error(
      'DWG is a proprietary binary format that cannot be parsed in the ' +
      'browser. Open the file in AutoCAD, LibreCAD, or QCAD and export ' +
      'as DXF (R2000 or later, ASCII), then import that DXF here.'
    );
  }
  if (!name.endsWith('.dxf')) {
    throw new Error(`Unsupported file type — only .dxf is accepted (got "${file.name}").`);
  }
  const text = await file.text();
  return parseDxfText(text);
}

export function parseDxfText(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim());
  // Pair the alternating (groupCode, value) lines.
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  if (pairs.length === 0) {
    throw new Error('Not a valid DXF file (no group-code pairs found).');
  }

  const insunits = readInsUnits(pairs);
  const unitScale = INSUNITS_TO_METERS[insunits] ?? 1;
  const polygons = [];

  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code !== 0) continue;
    if (value === 'LWPOLYLINE') {
      const result = readLWPolyline(pairs, i + 1);
      if (result.polygon) polygons.push(result.polygon);
      i = result.nextIdx - 1;
    } else if (value === 'POLYLINE') {
      const result = readLegacyPolyline(pairs, i + 1);
      if (result.polygon) polygons.push(result.polygon);
      i = result.nextIdx - 1;
    }
  }

  if (polygons.length === 0) {
    throw new Error(
      'No closed polylines found in this DXF. Room outlines must be drawn ' +
      'as a closed LWPOLYLINE or POLYLINE. If you used LINE segments, ' +
      'join them with the CAD tool\'s PEDIT / Join command first.'
    );
  }

  // Scale to meters + compute area; keep only closed.
  const closed = [];
  for (const p of polygons) {
    if (!p.closed) continue;
    const verts = p.vertices.map(v => ({ x: v.x * unitScale, y: v.y * unitScale }));
    const area_m2 = Math.abs(signedArea(verts));
    if (verts.length >= 3 && area_m2 > 0.1) {
      closed.push({ vertices: verts, closed: true, area_m2, layer: p.layer });
    }
  }

  if (closed.length === 0) {
    throw new Error(
      'Closed polylines exist but none are large enough to be a room outline ' +
      '(minimum 0.1 m² after unit conversion). Check the DXF units — if it ' +
      'was drawn in mm, the file header may have lost that hint.'
    );
  }

  // Pick the largest-area polygon as the room. User can override later.
  let bestIndex = 0;
  for (let i = 1; i < closed.length; i++) {
    if (closed[i].area_m2 > closed[bestIndex].area_m2) bestIndex = i;
  }

  return {
    polygons: closed,
    units: 'm',
    source_units: UNIT_LABEL[insunits] ?? `code ${insunits}`,
    bestIndex,
  };
}

// Scan HEADER section for $INSUNITS (group code 70 after the variable name).
function readInsUnits(pairs) {
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
      // Next code-70 value is the unit enum.
      for (let j = i + 1; j < pairs.length && j < i + 10; j++) {
        if (pairs[j][0] === 70) return parseInt(pairs[j][1], 10) || 0;
      }
    }
  }
  return 0;
}

// LWPOLYLINE: flat list of 10/20 coord pairs until next 0-code entity.
function readLWPolyline(pairs, startIdx) {
  let layer = '0';
  let flags = 0;
  const xs = [], ys = [], bulges = [];
  let pendingBulge = 0;
  let i = startIdx;
  for (; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) break;
    else if (code === 8) layer = value;
    else if (code === 70) flags = parseInt(value, 10) | 0;
    else if (code === 10) { xs.push(parseFloat(value)); bulges.push(pendingBulge); pendingBulge = 0; }
    else if (code === 20) ys.push(parseFloat(value));
    else if (code === 42) pendingBulge = parseFloat(value);
  }
  const closed = (flags & 1) === 1;
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { polygon: null, nextIdx: i };
  const raw = [];
  for (let k = 0; k < n; k++) raw.push({ x: xs[k], y: ys[k], bulge: bulges[k] || 0 });
  const vertices = expandBulges(raw, closed);
  return { polygon: { vertices, closed, layer }, nextIdx: i };
}

// Legacy POLYLINE: 0/VERTEX children until 0/SEQEND.
function readLegacyPolyline(pairs, startIdx) {
  let layer = '0';
  let flags = 0;
  const raw = [];
  let i = startIdx;
  // Header block
  for (; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) break;
    else if (code === 8) layer = value;
    else if (code === 70) flags = parseInt(value, 10) | 0;
  }
  // VERTEX children
  while (i < pairs.length && pairs[i][0] === 0 && pairs[i][1] === 'VERTEX') {
    let vx = 0, vy = 0, vb = 0;
    i++;
    for (; i < pairs.length; i++) {
      const [code, value] = pairs[i];
      if (code === 0) break;
      else if (code === 10) vx = parseFloat(value);
      else if (code === 20) vy = parseFloat(value);
      else if (code === 42) vb = parseFloat(value);
    }
    raw.push({ x: vx, y: vy, bulge: vb });
  }
  // SEQEND
  if (i < pairs.length && pairs[i][0] === 0 && pairs[i][1] === 'SEQEND') i++;
  const closed = (flags & 1) === 1;
  if (raw.length < 3) return { polygon: null, nextIdx: i };
  const vertices = expandBulges(raw, closed);
  return { polygon: { vertices, closed, layer }, nextIdx: i };
}

// Convert raw {x,y,bulge} vertices to flat {x,y} list, sampling each
// bulge-segment to 4 line-segments (matches the precision used elsewhere
// in the app). Bulge = tan(included_angle / 4).
function expandBulges(raw, closed) {
  const out = [];
  const N = raw.length;
  const segmentsPerArc = 4;
  for (let k = 0; k < N; k++) {
    const a = raw[k];
    const isLast = k === N - 1;
    const b = isLast ? (closed ? raw[0] : null) : raw[k + 1];
    out.push({ x: a.x, y: a.y });
    if (!b) continue;
    if (Math.abs(a.bulge) < 1e-6) continue;
    // Sample the arc between a and b (excluding both endpoints — b is
    // pushed as out[k+1] in the next iteration, or is raw[0] which already
    // exists at out[0] when closed).
    const theta = 4 * Math.atan(a.bulge);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Perpendicular from chord midpoint to arc centre
    const dx = b.x - a.x, dy = b.y - a.y;
    const perpLen = r * Math.cos(theta / 2);
    const px = -dy / chord, py = dx / chord;
    const sign = a.bulge > 0 ? 1 : -1;
    const cx = mx + sign * px * perpLen;
    const cy = my + sign * py * perpLen;
    const ang0 = Math.atan2(a.y - cy, a.x - cx);
    for (let s = 1; s < segmentsPerArc; s++) {
      const t = s / segmentsPerArc;
      const ang = ang0 + sign * theta * t;
      out.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
    }
  }
  return out;
}

function signedArea(verts) {
  let a = 0;
  for (let i = 0, n = verts.length; i < n; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
