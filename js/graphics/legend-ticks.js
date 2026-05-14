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

// Minor (unlabeled) ticks at finer intervals between the major ticks.
// Renders as short faded lines on the legend bar — "ruler graduations"
// per user request 2026-05-14. Step rules mirror the major-tick logic
// so the density scales with range:
//   SPL  span ≤ 30 dB  → minor step 1 dB  (e.g. 83–97 → 14 minors)
//   SPL  span ≤ 60 dB  → minor step 2 dB
//   SPL  span > 60 dB  → minor step 5 dB
//   STI                → minor step 0.05
// Positions that coincide with a major-tick value are excluded so the
// gradient doesn't render two lines on top of each other.
export function computeMinorTicks(min, max, mode, majorTicks = []) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const span = max - min;
  let step;
  if (mode === 'sti') {
    step = 0.05;
  } else {
    step = span <= 30 ? 1 : (span <= 60 ? 2 : 5);
  }
  const majorKeys = new Set(
    majorTicks.map(t => Math.round(t.value * 1000) / 1000),
  );
  const first = Math.ceil(min / step) * step;
  const last  = Math.floor(max / step) * step;
  const out = [];
  for (let v = first; v <= last + 1e-9; v += step) {
    const key = Math.round(v * 1000) / 1000;
    if (majorKeys.has(key)) continue;
    out.push({ value: v, position01: (v - min) / span });
  }
  return out;
}

// Format a tick value for display. SPL → integer + dB suffix; STI → 2
// decimals (unitless). Maya's call: pros scan tick lists; they don't
// connect a header unit to 6 numbers below. Repeating the unit on
// every tick is redundant in a column header but correct on a list of
// values (Treble, Odeon, EASE all do this in their plot legends).
export function formatTickLabel(value, mode) {
  if (mode === 'sti') return value.toFixed(2);
  return `${Math.round(value)} dB`;
}

// Header label for the legend column / row. Returns the metric NAME
// with context (frequency for SPL, IEC tier for STI), never the bare
// unit. Earlier this function returned `'dB'` which orphaned next to
// the gradient bar with no metric context. Per Maya v9 audit §1 —
// header is for "what is this," tick labels are for "what value."
//
// Args:
//   mode    — 'spl' | 'sti'
//   freqHz  — frequency the SPL field was evaluated at (default 1000).
export function legendHeader(mode, freqHz = 1000) {
  if (mode === 'sti') return 'STI';
  // Format frequency: 1000 → '1 kHz', 500 → '500 Hz', 2000 → '2 kHz'.
  const f = Number.isFinite(freqHz) ? freqHz : 1000;
  const freqLabel = f >= 1000 ? `${(f / 1000).toFixed(f % 1000 ? 1 : 0)} kHz` : `${Math.round(f)} Hz`;
  return `SPL @ ${freqLabel}`;
}
