// Shared header navigation — three pill tabs that switch between Labs.
// Each Lab calls mountHeaderNav() once during boot with its own ID;
// the matching tab gets aria-current="page" and visual active state.
//
// Multi-page architecture (no SPA router) — each tab is a plain <a href>
// so the browser handles back/refresh natively, middle-click works, and
// SpeakerLAB never needs to import Three.js just to navigate.

const LABS = [
  {
    id: 'room',
    label: 'RoomLAB',
    href: 'index.html',
    sublabel: 'Acoustic simulator',
    enabled: true,
  },
  {
    id: 'speaker',
    label: 'SpeakerLAB',
    href: 'speakers.html',
    sublabel: 'Speaker library',
    enabled: true,
  },
  {
    id: 'device',
    label: 'DeviceLAB',
    href: 'devices.html',
    sublabel: 'PA equipment',
    enabled: true,
  },
];

// Mount the nav into <header id="app-header">. Replaces any existing
// content in that header (the previous <h1>RoomLAB</h1> placeholder).
//
// activeLab must be one of the LABS.id values — the matching tab gets
// aria-current="page" and the .active class for visual treatment.
export function mountHeaderNav({ activeLab }) {
  const header = document.getElementById('app-header');
  if (!header) return;

  const tabs = LABS.map(lab => {
    const isActive = lab.id === activeLab;
    const classes = ['lab-tab'];
    if (isActive) classes.push('active');
    if (!lab.enabled) classes.push('disabled');
    const aria = isActive ? ' aria-current="page"' : '';
    // Disabled tabs render as <span> so they're not navigable. Active
    // tab still renders as <a> for keyboard a11y but onClick prevents
    // navigation to the same page.
    if (!lab.enabled) {
      return `
        <span class="${classes.join(' ')}" data-lab="${lab.id}"
              title="${lab.label} — coming soon" aria-disabled="true">
          <span class="lab-tab-label">${lab.label}</span>
          <span class="lab-tab-sub">${lab.sublabel}</span>
        </span>`;
    }
    return `
      <a class="${classes.join(' ')}" data-lab="${lab.id}" href="${lab.href}"${aria}>
        <span class="lab-tab-label">${lab.label}</span>
        <span class="lab-tab-sub">${lab.sublabel}</span>
      </a>`;
  }).join('');

  header.innerHTML = `
    <div class="app-brand">RoomLAB Suite</div>
    <nav class="lab-nav" aria-label="Lab navigation">${tabs}</nav>
  `;

  // Block navigation when the user clicks the already-active tab —
  // saves a needless reload and keeps any in-flight unsaved state.
  header.querySelectorAll('a.lab-tab.active').forEach(a => {
    a.addEventListener('click', e => e.preventDefault());
  });
}
