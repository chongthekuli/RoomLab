// Shared SPL / STI colour ramps. Single source of truth for the heatmap
// colour mapping used by the 2D viewport, the 3D viewport, and the print
// report. Per Sofia's design spec (v1) — "extract `splColorRGB` to
// `js/graphics/colour-ramps.js` so all three viewports share one source."
// Anti-pattern this prevents: ramp drift between paths (3D legend showing
// a different colour for "85 dB" than the 2D legend).

// SPL — punchier 4-stop ramp: saturated blue → cyan-green → yellow → red.
// Domain is 60-110 dB; values outside clamp to the endpoint colours.
export function splColorRGB(spl_db) {
  const t = Math.max(0, Math.min(1, (spl_db - 60) / 50));
  if (t < 0.25) return interpRGB([ 20,  40, 180], [  0, 140, 230], t / 0.25);
  if (t < 0.50) return interpRGB([  0, 140, 230], [ 30, 220,  80], (t - 0.25) / 0.25);
  if (t < 0.75) return interpRGB([ 30, 220,  80], [255, 215,   0], (t - 0.50) / 0.25);
  return interpRGB([255, 215, 0], [240, 30, 30], (t - 0.75) / 0.25);
}

// STI — IEC 60268-16 five-tier mapped to red→orange→yellow→green→teal.
// Domain 0-1; tier boundaries at 0.30 / 0.45 / 0.60 / 0.75 are the IEC
// rating tier breakpoints, so a colour change is visible across each tier.
export function stiColorRGB(sti) {
  const t = Math.max(0, Math.min(1, sti));
  if (t < 0.30) return interpRGB([210,  20,  20], [255, 130,  20], t / 0.30);
  if (t < 0.45) return interpRGB([255, 130,  20], [255, 215,   0], (t - 0.30) / 0.15);
  if (t < 0.60) return interpRGB([255, 215,   0], [ 60, 210,  60], (t - 0.45) / 0.15);
  if (t < 0.75) return interpRGB([ 60, 210,  60], [  0, 200, 150], (t - 0.60) / 0.15);
  return interpRGB([0, 200, 150], [0, 170, 220], (t - 0.75) / 0.25);
}

function interpRGB(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Convenience: pick the right ramp by metric tag. Used wherever a caller
// gets a value but the metric mode is parameterised (heatmap painter,
// legend renderer, print figure).
export function colorForMetric(value, metric) {
  return metric === 'sti' ? stiColorRGB(value) : splColorRGB(value);
}
