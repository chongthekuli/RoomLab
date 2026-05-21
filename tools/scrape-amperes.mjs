// Scraper for real Amperes Electronics speaker specs.
//
//   node tools/scrape-amperes.mjs
//
// The ampereselectronics.com product pages are Wix/JS-rendered, so the
// visible spec table is NOT in the static DOM a plain fetch sees — BUT Wix
// embeds the rendered content as JSON inside a `wix-warmup-data` blob in the
// page HTML. We pull the page with curl (a browser UA gets the warmup blob),
// scan the ordered `"text":"…"` rich-text values, and parse the spec table
// (driver size, frequency response, SPL@1W/1m, dimensions, weight, taps,
// impedance). Coverage/dispersion angle is NOT published anywhere on the
// pages, so that one field stays modelled in the generator.
//
// Output: tools/amperes-scraped.json  (id → real spec fields). The generator
// (gen-amperes-speakers.mjs) merges this over its estimates: real wins.
//
// Column models live on COMBINED pages (one page lists CL902–916 side by
// side), so those are parsed positionally against an explicit model order.

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.ampereselectronics.com';

// Per-model page resolution. `single` pages each describe one model; `multi`
// pages tabulate several models in a fixed left-to-right order.
const SINGLE = {
  bs410: ['/bs410', '/box-speakers/bs410'],
  bs506: ['/bs506', '/box-speakers/bs506'],
  bs508: ['/bs508', '/box-speakers/bs508'],
  fs420: ['/fs420', '/fs-speakers/fs420'],
  fs425: ['/fs425', '/fs-speakers/fs425'],
  fs338: ['/fs338', '/fs-speakers/fs338'],
  fs640: ['/fs640', '/fs-speakers/fs640'],
  fs650: ['/fs650', '/fs-speakers/fs650'],
  hs815: ['/horn-speakers/hs815', '/hs815'],
  hs830: ['/horn-speakers/hs830', '/hs830'],
  hs820: ['/horn-speakers/hs820', '/hs820'],
  hs822: ['/horn-speakers/hs822', '/hs822'],
  hs725: ['/horn-speakers/hs725', '/hs725'],
  hs750: ['/horn-speakers/hs750', '/hs750'],
  hs810: ['/horn-speakers/hs810', '/hs810'],
  hs880: ['/horn-speakers/hs880', '/hs880'],
  lh100: ['/horn-speakers/lh100', '/lh100'],
  lh201: ['/horn-speakers/lh201', '/lh201'],
  sp219: ['/sp219', '/horn-speakers/sp219'],
  sp220: ['/sp220', '/horn-speakers/sp220'],
  sp319: ['/sp319', '/horn-speakers/sp319'],
  sg320: ['/sg320', '/pendant-garden-speakers/sg320'],
  ps820: ['/ps820', '/pendant-garden-speakers/ps820'],
};
const MULTI = [
  { url: '/cl900', models: ['cl902', 'cl904', 'cl908', 'cl912', 'cl916'] },
  { url: '/cl740-780', models: ['cl740', 'cl780'] },
];

function fetchHtml(url) {
  try {
    return execSync(`curl -sL -A "${UA}" "${BASE}${url}"`, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  } catch { return ''; }
}

// Ordered, NON-deduped rich-text fragments from the Wix warmup JSON.
function textFragments(html) {
  const out = [];
  for (const m of html.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)) {
    let s = m[1]
      .replace(/\\u003c[^"]*?\\u003e/gi, ' ')   // escaped tags
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ')
      .replace(/\\[ntr/]/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      .replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
  }
  return out;
}

const isLabel = (s) => /(power rating|driver|power taps|primary impedance|secondary impedance|driver impedance|frequency response|spl ?@|dimensions|physical dimensions|net weight|gross weight|carton|coverage|dispersion|impedance|power requirements|power consumption)/i.test(s);

// Everything from here on belongs to the cross-reference / compatible-amplifier
// section (e.g. MM8804, a 19" rack unit whose 482×44×180 mm contaminated the
// first scrape), or to packaging — NOT the product's own spec table. Cut it.
// NB: do NOT include "power requirements"/"power consumption" here — garden &
// pendant pages use "Power Requirements" as a legit first spec label. The
// amplifier cross-ref block is reliably preceded by these listing/packaging
// markers instead.
const CROSS_REF = /hide on listing page|display on nested tab|cross.?reference|MM\d{3,4}|carton size|gross weight/i;
function trimToProduct(frags) {
  const cut = frags.findIndex(s => CROSS_REF.test(s));
  return cut > 0 ? frags.slice(0, cut) : frags;
}

// Parse the values that follow a label, up to the next label. For single
// pages a label has one value; for multi pages it has one per model.
function valuesAfter(frags, labelRe, max) {
  const i = frags.findIndex(s => labelRe.test(s));
  if (i < 0) return [];
  const vals = [];
  for (let j = i + 1; j < frags.length && vals.length < max; j++) {
    if (isLabel(frags[j])) break;
    vals.push(frags[j]);
  }
  return vals;
}

const num = (s) => { const m = String(s).match(/-?[0-9]+(?:\.[0-9]+)?/); return m ? parseFloat(m[0]) : null; };

function parseFreq(s) {
  // "100 - 16 kHz", "90 - 17 kHz", "200 Hz - 8 kHz" → [lowHz, highHz].
  // Units may appear on the low side, the high side, or only the high side.
  const m = String(s).match(/([0-9.]+)\s*(kHz|Hz)?\s*[-–]\s*([0-9.]+)\s*(kHz|Hz)/i);
  if (!m) return null;
  const scale = (n, u) => /k/i.test(u || '') ? n * 1000 : n;
  const lo = scale(parseFloat(m[1]), m[2]);                 // bare low → Hz
  const hi = scale(parseFloat(m[3]), m[4]);
  if (!(hi > lo) || hi < 1000) return null;                 // sanity
  return [Math.round(lo), Math.round(hi)];
}
function parseDims(s) {
  // Strip W/H/D/L cell annotations ("730 (W) x 385 (H) x 1565 (D) mm") but keep
  // (diameter)/(height), which we need to tell a bollard from a round horn.
  s = String(s).replace(/\(\s*(?:w|h|d|l)\s*\)/gi, ' ');
  const N = '([0-9]+(?:\\.[0-9]+)?)';
  // Box: "185 x 215 x 90 mm" (W x H x D).
  let m = s.match(new RegExp(`${N}\\s*x\\s*${N}\\s*x\\s*${N}\\s*mm`, 'i'));
  if (m) return { w_mm: +m[1], h_mm: +m[2], d_mm: +m[3], form: 'box' };
  // Bollard (stands upright): "320 mm (diameter) x 360 mm (height)" → 2nd is HEIGHT.
  m = s.match(new RegExp(`${N}\\s*mm\\s*\\(diameter\\)\\s*x\\s*${N}\\s*mm\\s*\\(height\\)`, 'i'));
  if (m) { const dia = +m[1]; return { w_mm: dia, h_mm: +m[2], d_mm: dia, form: 'bollard' }; }
  // Round flare / cylinder with the word diameter: "536 (diameter) x 1170 mm",
  // "504 diameter x 335 mm" → diameter × depth(length).
  m = s.match(new RegExp(`${N}\\s*(?:mm)?\\s*\\(?diameter\\)?\\s*x\\s*${N}\\s*mm`, 'i'));
  if (m) { const dia = +m[1]; return { w_mm: dia, h_mm: dia, d_mm: +m[2], form: 'round' }; }
  // Bare two-number "210 x 240 mm" — in this catalogue always a round flare /
  // projector tube quoted as (diameter × depth).
  m = s.match(new RegExp(`^${N}\\s*x\\s*${N}\\s*mm`, 'i'));
  if (m) { const dia = +m[1]; return { w_mm: dia, h_mm: dia, d_mm: +m[2], form: 'round' }; }
  // Sphere / round-only: "254 mm (diameter)".
  m = s.match(new RegExp(`${N}\\s*mm\\s*\\(diameter\\)`, 'i'));
  if (m) { const dia = +m[1]; return { w_mm: dia, h_mm: dia, d_mm: dia, form: 'sphere' }; }
  return null;
}
function parseDriverMm(s) {
  const m = String(s).match(/\(([0-9]+(?:\.[0-9]+)?)\s*mm\)/);
  return m ? +m[1] : null;
}
function parseDriverInch(s) {
  const m = String(s).match(/([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|inch|PP|dual|driver)/i);
  return m ? +m[1] : null;
}

function specFromFrags(frags, idxInRow = 0, single = false) {
  // idxInRow: which value to take when a label is followed by several (multi page).
  const pick = (re, parser, max = idxInRow + 1) => {
    const vals = valuesAfter(frags, re, max);
    const v = vals[idxInRow] ?? vals[0];
    return v == null ? null : (parser ? parser(v) : v);
  };
  // Global scan: first frag whose parser yields a value (used on single-product
  // pages, where some tables interleave label cells so the value isn't the
  // immediate next frag — e.g. big horns list "Flare dimension" + "Driver
  // connector" labels before the value). Multi pages stay positional.
  const scan = (parser) => { for (const s of frags) { const v = parser(s); if (v != null) return v; } return null; };

  const splVal = pick(/\bspl\b/i, num, idxInRow + 1);
  let freqVal = single ? scan(parseFreq) : pick(/frequency response|frequency range/i, parseFreq, idxInRow + 1);
  if (!freqVal && !single) { const f = frags.map(parseFreq).find(Boolean); if (f) freqVal = f; }
  const dimVal = single ? scan(parseDims) : pick(/dimensions|physical dimensions|flare dimension/i, parseDims, idxInRow + 1);
  let wtVal = single
    ? scan((s) => { if (!/kg/i.test(s)) return null; const n = num(s); return (n != null && n >= 0.05 && n <= 60) ? n : null; })
    : pick(/net weight|^weight$|weight ?\(/i, (s) => num(s), idxInRow + 1);
  // Sanity filters: drop a generic 20 Hz–20 kHz placeholder, and reject a
  // per-unit weight outside a believable single-speaker range (carton/bogus).
  if (freqVal && freqVal[0] <= 20 && freqVal[1] >= 20000) freqVal = null;
  if (wtVal != null && (wtVal > 60 || wtVal < 0.05)) wtVal = null;
  const drvRaw = pick(/power rating|driver/i, null, idxInRow + 1);
  const driver_mm = drvRaw ? parseDriverMm(drvRaw) : null;
  const driver_in = drvRaw ? parseDriverInch(drvRaw) : null;
  const taps = pick(/power taps/i, null, idxInRow + 1);
  return {
    sens_db: splVal,
    freq_hz: freqVal,
    dims_mm: dimVal,
    net_weight_kg: wtVal,
    driver_mm,
    driver_in,
    driver_raw: drvRaw,
    taps,
  };
}

const result = {};
const report = [];

for (const [id, urls] of Object.entries(SINGLE)) {
  let frags = [], usedUrl = null;
  for (const u of urls) {
    const html = fetchHtml(u);
    const f = textFragments(html);
    if (f.some(s => /physical dimensions|dimensions \(|frequency response/i.test(s))) { frags = f; usedUrl = u; break; }
  }
  if (!frags.length) { report.push(`${id.padEnd(7)} MISSING (no spec page)`); continue; }
  const spec = specFromFrags(trimToProduct(frags), 0, true);
  spec._url = usedUrl;
  result[id] = spec;
  report.push(`${id.padEnd(7)} ${usedUrl.padEnd(26)} drv=${spec.driver_mm ?? '?'}mm sens=${spec.sens_db ?? '?'}dB freq=${spec.freq_hz ? spec.freq_hz.join('-') : '?'} dims=${spec.dims_mm ? `${spec.dims_mm.w_mm}x${spec.dims_mm.h_mm}x${spec.dims_mm.d_mm}` : '?'} wt=${spec.net_weight_kg ?? '?'}kg`);
}

for (const { url, models } of MULTI) {
  const html = fetchHtml(url);
  const frags = trimToProduct(textFragments(html));
  models.forEach((id, idx) => {
    const spec = specFromFrags(frags, idx);
    spec._url = url;
    result[id] = spec;
    report.push(`${id.padEnd(7)} ${url.padEnd(26)} [col ${idx}] drv=${spec.driver_mm ?? '?'}mm sens=${spec.sens_db ?? '?'}dB freq=${spec.freq_hz ? spec.freq_hz.join('-') : '?'} dims=${spec.dims_mm ? `${spec.dims_mm.w_mm}x${spec.dims_mm.h_mm}x${spec.dims_mm.d_mm}` : '?'} wt=${spec.net_weight_kg ?? '?'}kg`);
  });
}

const outFile = join(__dirname, 'amperes-scraped.json');
writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(report.join('\n'));
console.log(`\nWrote ${Object.keys(result).length} models to ${outFile}`);
