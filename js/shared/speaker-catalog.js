// Shared speaker catalogue — the list of loudspeaker JSONs every Lab
// can read from. RoomLAB picks a model for each source; SpeakerLAB
// browses the full library; DeviceLAB will eventually let you assign
// speakers to amplifier channels.
//
// User-imported speakers (custom JSON / CLF / GLL) will join this list
// at runtime via a future IndexedDB-backed registry — for now this is
// the static manifest of repo-bundled definitions only.
//
// app-state.js re-exports SPEAKER_CATALOG from here so RoomLAB's
// existing import sites keep working without churn.

export const SPEAKER_CATALOG = [
  { url: 'data/loudspeakers/generic-12inch.json',       label: 'Generic 12" 2-way' },
  { url: 'data/loudspeakers/compact-6inch.json',        label: 'Compact 6" monitor' },
  { url: 'data/loudspeakers/line-array-element.json',   label: 'Line-array element' },
  // ----- Amperes Electronics ceiling speakers (ampereselectronics.com) -----
  { url: 'data/loudspeakers/amperes-cs210.json',        label: 'Amperes CS210 (2" dual-cone)' },
  { url: 'data/loudspeakers/amperes-cs343.json',        label: 'Amperes CS343 (4" IP65)' },
  { url: 'data/loudspeakers/amperes-cs510.json',        label: 'Amperes CS510 (5" dual-cone)' },
  { url: 'data/loudspeakers/amperes-cs515.json',        label: 'Amperes CS515 (5" honeycomb)' },
  { url: 'data/loudspeakers/amperes-cs516.json',        label: 'Amperes CS516 (5" surface)' },
  { url: 'data/loudspeakers/amperes-cs518.json',        label: 'Amperes CS518 (5" square co-axial)' },
  { url: 'data/loudspeakers/amperes-cs520.json',        label: 'Amperes CS520 (5" co-axial)' },
  { url: 'data/loudspeakers/amperes-cs606.json',        label: 'Amperes CS606 (6" metal)' },
  { url: 'data/loudspeakers/amperes-cs606fr-e.json',    label: 'Amperes CS606FR-E (EN54)' },
  { url: 'data/loudspeakers/amperes-cs610.json',        label: 'Amperes CS610 (6" dual-cone)' },
  { url: 'data/loudspeakers/amperes-cs610b.json',       label: 'Amperes CS610B (6" 10 W)' },
  { url: 'data/loudspeakers/amperes-cs620.json',        label: 'Amperes CS620 (6.5" co-axial)' },
  { url: 'data/loudspeakers/amperes-cs630.json',        label: 'Amperes CS630 (6.5" 30 W co-axial)' },
  { url: 'data/loudspeakers/amperes-cs840.json',        label: 'Amperes CS840 (8" 40 W co-axial)' },
  // ----- Amperes surface-mount / box speakers (BS) -----
  { url: 'data/loudspeakers/amperes-bs410.json',        label: 'Amperes BS410 (4" 10 W half-moon)' },
  { url: 'data/loudspeakers/amperes-bs506.json',        label: 'Amperes BS506 (5" 6 W box)' },
  { url: 'data/loudspeakers/amperes-bs508.json',        label: 'Amperes BS508 (5" 10 W box)' },
  // ----- Amperes full-range music speakers (FS) -----
  { url: 'data/loudspeakers/amperes-fs420.json',        label: 'Amperes FS420 (4" 20 W full-range)' },
  { url: 'data/loudspeakers/amperes-fs425.json',        label: 'Amperes FS425 (4" 20 W IP65)' },
  { url: 'data/loudspeakers/amperes-fs338.json',        label: 'Amperes FS338 (dual 4" 40 W)' },
  { url: 'data/loudspeakers/amperes-fs640.json',        label: 'Amperes FS640 (6" 40 W full-range)' },
  { url: 'data/loudspeakers/amperes-fs650.json',        label: 'Amperes FS650 (6" 50 W + tweeter)' },
  // ----- Amperes column speakers (CL) -----
  { url: 'data/loudspeakers/amperes-cl902.json',        label: 'Amperes CL902 (slim column, 10 W)' },
  { url: 'data/loudspeakers/amperes-cl904.json',        label: 'Amperes CL904 (slim column, 20 W)' },
  { url: 'data/loudspeakers/amperes-cl908.json',        label: 'Amperes CL908 (slim column, 40 W)' },
  { url: 'data/loudspeakers/amperes-cl912.json',        label: 'Amperes CL912 (slim column, 60 W)' },
  { url: 'data/loudspeakers/amperes-cl916.json',        label: 'Amperes CL916 (slim column, 80 W)' },
  { url: 'data/loudspeakers/amperes-cl740.json',        label: 'Amperes CL740 (4" weatherproof column, 40 W)' },
  { url: 'data/loudspeakers/amperes-cl780.json',        label: 'Amperes CL780 (4" weatherproof column, 80 W)' },
  // ----- Amperes horn speakers (HS / LH) -----
  { url: 'data/loudspeakers/amperes-hs815.json',        label: 'Amperes HS815 (8" round horn, 15 W)' },
  { url: 'data/loudspeakers/amperes-hs830.json',        label: 'Amperes HS830 (12" round horn, 30 W)' },
  { url: 'data/loudspeakers/amperes-hs820.json',        label: 'Amperes HS820 (6"×8" rect horn, 15 W)' },
  { url: 'data/loudspeakers/amperes-hs822.json',        label: 'Amperes HS822 (11"×8" rect horn, 30 W)' },
  { url: 'data/loudspeakers/amperes-hs725.json',        label: 'Amperes HS725 (music horn, 30 W)' },
  { url: 'data/loudspeakers/amperes-hs750.json',        label: 'Amperes HS750 (clear horn, 50 W)' },
  { url: 'data/loudspeakers/amperes-hs810.json',        label: 'Amperes HS810 (14" long-range horn, 100 W)' },
  { url: 'data/loudspeakers/amperes-hs880.json',        label: 'Amperes HS880 (20" long-throw horn, 80 W)' },
  { url: 'data/loudspeakers/amperes-lh100.json',        label: 'Amperes LH100 (tunnel EVAC horn, 100 W)' },
  { url: 'data/loudspeakers/amperes-lh201.json',        label: 'Amperes LH201 (21" long-throw horn, 100 W)' },
  // ----- Amperes sound projectors (SP) -----
  { url: 'data/loudspeakers/amperes-sp219.json',        label: 'Amperes SP219 (15 W unidirectional projector)' },
  { url: 'data/loudspeakers/amperes-sp220.json',        label: 'Amperes SP220 (20 W IP65 projector)' },
  { url: 'data/loudspeakers/amperes-sp319.json',        label: 'Amperes SP319 (40 W bidirectional projector)' },
  // ----- Amperes garden / pendant speakers (SG / PS) -----
  { url: 'data/loudspeakers/amperes-sg320.json',        label: 'Amperes SG320 (20 W 360° garden)' },
  { url: 'data/loudspeakers/amperes-ps820.json',        label: 'Amperes PS820 (8" 20 W pendant ball)' },
];

// ---------------------------------------------------------------------------
// Canonical speaker-category taxonomy.
//
// The category is stored on each loudspeaker JSON's `mount_type` field —
// reused as the single source of truth rather than introducing a parallel
// `category` field that could drift. (`mount_type === 'ceiling'` already
// drives the 3D ceiling-cutout rendering in scene.js, so that behaviour is
// preserved.) `value` is the canonical token written in the JSON; `label`
// is what the report + SpeakerLAB filter display.
//
// Note: 'full-range' and 'bookshelf' describe driver config / form factor
// rather than a mount method, so this list intentionally mixes taxonomies —
// it is the user-facing product-category list, not a strict mounting enum.
export const SPEAKER_CATEGORIES = [
  { value: 'ceiling',         label: 'Ceiling' },
  { value: 'surface-mount',   label: 'Surface Mount' },
  { value: 'horn',            label: 'Horn' },
  { value: 'sound-projector', label: 'Sound Projector' },
  { value: 'full-range',      label: 'Full Range' },
  { value: 'column',          label: 'Column' },
  { value: 'garden',          label: 'Garden' },
  { value: 'pendant',         label: 'Pendant' },
  { value: 'bookshelf',       label: 'Bookshelf' },
];

// value → display label. Unknown / missing values fall back to
// 'Uncategorised' so a speaker with no mount_type still groups cleanly.
export function speakerCategoryLabel(value) {
  const hit = SPEAKER_CATEGORIES.find(c => c.value === value);
  return hit ? hit.label : 'Uncategorised';
}

// Convenience: split the catalogue by manufacturer for the SpeakerLAB
// library browser sidebar. Returns
//   [ { manufacturer: 'Amperes Electronics', items: [...] }, { manufacturer: 'Generic', items: [...] } ]
// in stable display order. Manufacturer is inferred from the label
// prefix — entries starting with "Amperes" group together; everything
// else falls under "Generic".
export function groupCatalogueByManufacturer(catalog = SPEAKER_CATALOG) {
  const buckets = new Map();
  const order = ['Amperes Electronics', 'Generic'];
  for (const entry of catalog) {
    const manufacturer = /^Amperes/i.test(entry.label) ? 'Amperes Electronics' : 'Generic';
    if (!buckets.has(manufacturer)) buckets.set(manufacturer, []);
    buckets.get(manufacturer).push(entry);
  }
  return order
    .filter(name => buckets.has(name))
    .map(manufacturer => ({ manufacturer, items: buckets.get(manufacturer) }));
}

// Lookup helper used by deep-links (?model=<url>) so SpeakerLAB can
// resolve a URL against the catalogue without scanning manually.
export function findCatalogEntry(modelUrl, catalog = SPEAKER_CATALOG) {
  return catalog.find(c => c.url === modelUrl) ?? null;
}
