// First-run onboarding card — overlays the viewport with a 4-step workflow
// so new users don't face a blank simulator with no guidance. Dismissal is
// sticky (localStorage), so returning users never see it again.

const DISMISS_KEY = 'roomlab.welcome.dismissed.v2';

export function mountWelcomeCard({ force = false } = {}) {
  if (!force && localStorage.getItem(DISMISS_KEY) === '1') return;
  // Don't stack duplicates if the user clicks "Show welcome" twice.
  const existing = document.getElementById('welcome-card');
  if (existing) existing.remove();
  const viewport = document.getElementById('viewport');
  if (!viewport) return;

  const card = document.createElement('div');
  card.id = 'welcome-card';
  card.innerHTML = `
    <button id="welcome-close" title="Dismiss (won't show again)" aria-label="Close">×</button>
    <h3>Welcome to RoomLAB</h3>
    <p class="welcome-sub">Acoustic simulator — predict speech intelligibility and SPL coverage before you build.</p>
    <ol class="welcome-steps">
      <li>
        <span class="welcome-step-num">1</span>
        <div><strong>Pick a room preset</strong><br><span class="welcome-hint">Left rail → Room panel. Or import a DXF floor plan.</span></div>
      </li>
      <li>
        <span class="welcome-step-num">2</span>
        <div><strong>Add speakers</strong><br><span class="welcome-hint">Sources panel → choose a loudspeaker model and drop it in.</span></div>
      </li>
      <li>
        <span class="welcome-step-num">3</span>
        <div><strong>Place listeners</strong><br><span class="welcome-hint">Listeners panel → click the floor to mark measurement points.</span></div>
      </li>
      <li>
        <span class="welcome-step-num">4</span>
        <div><strong>Read the results</strong><br><span class="welcome-hint">Right rail shows reverberation and SPL. Toggle STIPA heatmap for intelligibility.</span></div>
      </li>
    </ol>
    <div class="welcome-foot">
      Hover technical terms (RT60, STI, C80…) for inline definitions. Press <kbd>?</kbd> for keyboard shortcuts.
    </div>
  `;
  viewport.appendChild(card);

  card.querySelector('#welcome-close').addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    card.remove();
  });
}
