// Shared legend-tick computation. Single source of truth for how the SPL
// or STI legend lays out its numeric scale across the 2D viewport, the
// 3D viewport, and the print-report heatmap legend. Per Sofia's design
// spec (v1) — "Extract to `js/graphics/legend-ticks.js` exporting
// `computeTicks(min, max, mode)` ... cap at 7 ticks to avoid label
// collision."
//
// Returns an array of { value, position01 } pairs, where position01 is
// the 0..1 fraction of the legend's height (or width) at which the tick
// lives — so callers can draw at any size without doing the maths
// themselves.
//
// Step rules:
//   • SPL: 5 dB step if range ≤ 25 dB, else 10 dB. Re-derive if more
//     than 7 ticks fall inside the range — double the step until ≤ 7.
//   • STI: fixed at 0.30 / 0.45 / 0.60 / 0.75 (IEC 60268-16 rating
//     tier boundaries). Plus 0.00 and 1.00 endpoints — total 6.

export function computeTicks(min, max, mode) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  if (mode === 'sti') {
    const span = max - min;
    return [0.00, 0.30, 0.45, 0.60, 0.75, 1.00]
      .map(v => ({ value: v, position01: (v - min) / span }))
      .filter(t => t.position01 >= -0.01 && t.position01 <= 1.01);
  }
  // SPL.
  const span = max - min;
  let step = span <= 30 ? 5 : 10;
  let first = Math.ceil(min / step) * step;
  let last  = Math.floor(max / step) * step;
  let count = Math.floor((last - first) / step) + 1;
  if (count > 7) {
    step *= 2;
    first = Math.ceil(min / step) * step;
    last  = Math.floor(max / step) * step;
    count = Math.floor((last - first) / step) + 1;
  }
  const out = [];
  if (count >= 1) {
    for (let v = first; v <= last + 1e-6; v += step) {
      out.push({ value: v, position01: (v - min) / span });
    }
  }
  return out;
}

// Format a tick value for display. SPL → integer dB; STI → 2 decimals.
export function formatTickLabel(value, mode) {
  if (mode === 'sti') return value.toFixed(2);
  return Math.round(value).toString();
}

// Header label for the legend column / row, including the unit.
export function legendHeader(mode) {
  return mode === 'sti' ? 'STI' : 'dB';
}
