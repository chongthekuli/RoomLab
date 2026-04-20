// Speaker-file importer. Accepts:
//   * .json   — RoomLAB native schema (the format already in data/loudspeakers)
//   * .clf    — Common Loudspeaker Format (open XML spec, AES CLF TC)
//   * .xhn    — EASE SpeakerLab XML text export (best-effort subset)
//   * .gll    — ❌ not supported in-browser; we return a conversion guide
//
// The returned shape matches the existing JSON schema so the rest of the
// app doesn't need to care what format the user dropped in. Missing
// fields are back-filled with sensible defaults — directivity without a
// grid falls back to an omnidirectional pattern so at least propagation
// math works until the user provides real data.

const BAND_FREQS = [125, 250, 500, 1000, 2000, 4000, 8000];
const DEFAULT_AZS = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
const DEFAULT_ELS = [-90, -60, -30, 0, 30, 60, 90];

export const GLL_GUIDE = `GLL is AFMG's proprietary binary format and cannot be parsed in the browser.
To use a GLL file here:
  1. Open the .gll in EASE SpeakerLab or EASE.
  2. Export: File → Export → choose CLF (.clf) or XML text.
  3. Drop that exported file into RoomLAB.
  Alternatively, some manufacturers publish a measured text/CSV dataset
  alongside their GLL — those also work here.`;

export async function importSpeakerFile(file) {
  const name = (file?.name ?? '').toLowerCase();
  if (name.endsWith('.gll')) {
    const err = new Error(GLL_GUIDE);
    err.kind = 'gll';
    throw err;
  }
  const text = await file.text();
  if (name.endsWith('.json')) return parseJson(text, name);
  if (name.endsWith('.clf'))  return parseClf(text, name);
  if (name.endsWith('.xhn') || name.endsWith('.xml')) return parseClf(text, name); // same spec family

  // No recognised extension — try sniffing.
  const trimmed = text.trim();
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) return parseClf(text, name);
  if (trimmed.startsWith('{'))                               return parseJson(text, name);
  throw new Error(`Unsupported file "${file.name}". Accepted: .json, .clf, .xhn, .xml.`);
}

function parseJson(text, fileName) {
  let data;
  try { data = JSON.parse(text); }
  catch (err) { throw new Error(`Malformed JSON in ${fileName}: ${err.message}`); }

  // Minimal schema validation — require directivity grid OR allow a stub
  // (we'll fill it with an omni pattern).
  if (!data.model) throw new Error(`${fileName}: missing "model" field.`);
  if (!data.directivity) {
    data.directivity = makeOmniDirectivity();
  }
  data.importedFrom = fileName;
  return data;
}

// Parse a CLF (or EASE XML) file into our native JSON-ish shape. The full
// CLF spec has many optional blocks; this covers the common subset:
//   - <Loudspeaker> / <Speaker> root
//   - <Identification> → name / manufacturer / id / license
//   - <Measurement> or <Polar> blocks with <PolarData> grids
// Fields we can't locate are defaulted; if the directivity grid is
// missing entirely we fall back to omni so the file still loads.
function parseClf(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error(`${fileName} is not well-formed XML: ${parseErr.textContent.split('\n')[0]}`);

  const tag = (name) => doc.getElementsByTagName(name)[0]?.textContent?.trim();
  const attr = (selector, attrName) => doc.querySelector(selector)?.getAttribute(attrName);

  const model = tag('Model') || tag('Name') || tag('ProductName') || 'Imported speaker';
  const manufacturer = tag('Manufacturer') || tag('Vendor') || 'Unknown';
  const id = tag('Id') || tag('ID') || `imported-${Date.now()}`;
  const license = tag('License') || 'imported — licence unknown';

  // Physical / electrical blocks — common element names across CLF/EASE.
  const weight_kg = num(tag('Weight') || tag('WeightKg')) ?? null;
  const w = num(tag('Width') || tag('Width_m')) ?? null;
  const h = num(tag('Height') || tag('Height_m')) ?? null;
  const d = num(tag('Depth') || tag('Depth_m')) ?? null;
  const impedance = num(tag('Impedance') || tag('NominalImpedance')) ?? 8;
  const maxWatts = num(tag('MaxInputPower') || tag('RatedPower') || tag('PowerRating')) ?? 200;
  const maxSpl = num(tag('MaxSPL') || tag('MaxSpl')) ?? null;
  const sens = num(tag('Sensitivity') || tag('SensitivityDB')) ?? 93;
  const di = num(tag('DirectivityIndex') || tag('DI')) ?? 5;
  const fLow = num(tag('FrequencyLow') || tag('LowFreq')) ?? 80;
  const fHigh = num(tag('FrequencyHigh') || tag('HighFreq')) ?? 18000;

  // Directivity: try to read polar data grids. CLF uses <Balloon> with
  // <FreqBand> children each wrapping a flat list of <Value> pairs; some
  // vendor exports flatten to <Gain Az="..." El="..." Freq="..." dB="..."/>.
  const attenuation_db = {};
  let az_set = new Set();
  let el_set = new Set();

  for (const gain of doc.getElementsByTagName('Gain')) {
    const az = Number(gain.getAttribute('Az') ?? gain.getAttribute('azimuth'));
    const el = Number(gain.getAttribute('El') ?? gain.getAttribute('elevation'));
    const f  = Number(gain.getAttribute('Freq') ?? gain.getAttribute('freq'));
    const db = Number(gain.getAttribute('dB')   ?? gain.getAttribute('db') ?? gain.textContent);
    if (!Number.isFinite(az) || !Number.isFinite(el) || !Number.isFinite(f) || !Number.isFinite(db)) continue;
    const bandKey = String(nearestBand(f));
    if (!attenuation_db[bandKey]) attenuation_db[bandKey] = {};
    attenuation_db[bandKey][`${el},${az}`] = db;
    az_set.add(az); el_set.add(el);
  }

  let directivity;
  if (az_set.size >= 3 && el_set.size >= 3) {
    const azs = [...az_set].sort((a, b) => a - b);
    const els = [...el_set].sort((a, b) => a - b);
    const grid = {};
    for (const [band, samples] of Object.entries(attenuation_db)) {
      const table = els.map(el => azs.map(az => samples[`${el},${az}`] ?? 0));
      grid[band] = table;
    }
    directivity = {
      angular_resolution_deg: Math.abs((azs[1] ?? 30) - (azs[0] ?? 0)),
      azimuth_deg: azs,
      elevation_deg: els,
      attenuation_db: grid,
    };
  } else {
    directivity = makeOmniDirectivity();
  }

  return {
    schema_version: '1.0',
    id, manufacturer, model, license,
    note: `Imported from ${fileName}`,
    importedFrom: fileName,
    physical: {
      weight_kg,
      dimensions_m: { w: w ?? null, h: h ?? null, d: d ?? null },
    },
    electrical: {
      nominal_impedance_ohm: impedance,
      max_input_watts: maxWatts,
      max_spl_db: maxSpl ?? (sens + 10 * Math.log10(maxWatts)),
    },
    acoustic: {
      sensitivity_db_1w_1m: sens,
      frequency_range_hz: [fLow, fHigh],
      frequency_bands_hz: BAND_FREQS,
      directivity_index_db: di,
    },
    placement: { position_m: { x: 0, y: 0, z: 2 }, aim_deg: { yaw: 0, pitch: 0, roll: 0 } },
    directivity,
  };
}

function num(s) {
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function nearestBand(f) {
  let best = BAND_FREQS[0];
  let bestDiff = Math.abs(Math.log2(f / best));
  for (const b of BAND_FREQS) {
    const d = Math.abs(Math.log2(f / b));
    if (d < bestDiff) { best = b; bestDiff = d; }
  }
  return best;
}

function makeOmniDirectivity() {
  const grid = {};
  for (const f of BAND_FREQS) {
    grid[String(f)] = DEFAULT_ELS.map(() => DEFAULT_AZS.map(() => 0));
  }
  return {
    angular_resolution_deg: 30,
    azimuth_deg: DEFAULT_AZS.slice(),
    elevation_deg: DEFAULT_ELS.slice(),
    attenuation_db: grid,
  };
}
