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
];

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
