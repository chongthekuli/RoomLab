// Shared header navigation — three pill tabs that switch between Labs.
// In the SPA shell each tab is a hash-route link (`#/room`, `#/speaker`,
// `#/device`); the router handles activation by toggling the `.active`
// class via `data-lab` after each route change.
//
// Browser-native click behaviour does the work: clicking a tab updates
// window.location.hash → fires hashchange → router shows the matching
// `.lab-route` container. Middle-click / Cmd-click open in a new tab
// the same way they would for any anchor.

const LABS = [
  { id: 'room',    label: 'RoomLAB',    href: '#/room',    sublabel: 'Acoustic simulator' },
  { id: 'speaker', label: 'SpeakerLAB', href: '#/speaker', sublabel: 'Speaker library' },
  { id: 'device',  label: 'DeviceLAB',  href: '#/device',  sublabel: 'PA equipment' },
];

// Mount the nav into <header id="app-header">. activeLab is optional —
// when omitted (or invalid) the router will set the active state on
// route-change anyway. Provided as a convenience for callers that
// know the initial route synchronously.
export function mountHeaderNav({ activeLab } = {}) {
  const header = document.getElementById('app-header');
  if (!header) return;

  const tabs = LABS.map(lab => {
    const isActive = lab.id === activeLab;
    const classes = ['lab-tab'];
    if (isActive) classes.push('active');
    const aria = isActive ? ' aria-current="page"' : '';
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
}
