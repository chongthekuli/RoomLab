// Walk-mode touch HUD — virtual joystick + action buttons + rotate
// buttons, all dispatching synthetic keyboard events into the document
// so the existing ThirdPersonController handles them with no special
// touch-aware code path. Designed for tablet / phone use; visible
// (faded) on desktop too so the controls are discoverable.
//
// Why synthetic events vs. a direct controller hook? The controller
// already has solid keydown/keyup handling, key filtering for input
// fields, and gameplay quirks (jump-on-grounded, sit-on-press). Re-
// implementing those in a parallel touch path means double the bugs.
// Synthetic events route through ONE code path; if a future controller
// change tweaks key behaviour, the HUD picks it up for free.
//
// Lifecycle: mount() once at app start. show() / hide() on walk-mode
// enter / exit. The HUD's `hidden` attribute is the on/off switch.

const ACTIVE_TOUCHES = new Map();             // touchId → which control owns it
const PRESSED_KEYS = new Set();               // keys this HUD is currently holding

let _root, _joystick, _nub;
let _joyTouchId = null;
let _joyKeysHeld = new Set();                 // currently-pressed keys from joystick

const NUB_RADIUS_PX = 56 / 2;                 // matches CSS .walk-joystick-nub
const BASE_RADIUS_PX = 140 / 2;
const MAX_NUB_TRAVEL = BASE_RADIUS_PX - NUB_RADIUS_PX - 4;
const JOY_THRESHOLD = 0.35;                   // below this fraction = no input

function dispatchKey(type, code) {
  // Synthetic KeyboardEvent — bubbles through document where the
  // controller's listener picks it up. `key` is left empty; the
  // controller filters on e.code only.
  document.dispatchEvent(new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  }));
}

function pressKey(code) {
  if (PRESSED_KEYS.has(code)) return;
  PRESSED_KEYS.add(code);
  dispatchKey('keydown', code);
}

function releaseKey(code) {
  if (!PRESSED_KEYS.has(code)) return;
  PRESSED_KEYS.delete(code);
  dispatchKey('keyup', code);
}

// --- Joystick handling -------------------------------------------------
function joystickStart(e) {
  if (_joyTouchId !== null) return;
  const t = (e.touches && e.touches[0]) ?? e;
  _joyTouchId = t.identifier ?? 'mouse';
  _joystick.classList.add('is-active');
  joystickMove(e);
  e.preventDefault();
}
function joystickMove(e) {
  if (_joyTouchId === null) return;
  const t = e.touches
    ? Array.from(e.touches).find(x => x.identifier === _joyTouchId)
    : e;
  if (!t) return;
  const rect = _joystick.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let dx = t.clientX - cx;
  let dy = t.clientY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > MAX_NUB_TRAVEL) {
    dx *= MAX_NUB_TRAVEL / dist;
    dy *= MAX_NUB_TRAVEL / dist;
  }
  _nub.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  // Convert to keys. Threshold prevents jitter near rest.
  const fx = dx / MAX_NUB_TRAVEL;
  const fy = dy / MAX_NUB_TRAVEL;
  const want = new Set();
  if (fy < -JOY_THRESHOLD) want.add('KeyW');
  if (fy >  JOY_THRESHOLD) want.add('KeyS');
  if (fx < -JOY_THRESHOLD) want.add('KeyA');
  if (fx >  JOY_THRESHOLD) want.add('KeyD');
  // Diff: release keys we no longer want, press new ones.
  for (const k of _joyKeysHeld) if (!want.has(k)) releaseKey(k);
  for (const k of want)         if (!_joyKeysHeld.has(k)) pressKey(k);
  _joyKeysHeld = want;
  e.preventDefault();
}
function joystickEnd(e) {
  if (_joyTouchId === null) return;
  if (e.touches) {
    const stillTouched = Array.from(e.touches).some(x => x.identifier === _joyTouchId);
    if (stillTouched) return;
  }
  _joyTouchId = null;
  _joystick.classList.remove('is-active');
  _nub.style.transform = 'translate(0, 0)';
  for (const k of _joyKeysHeld) releaseKey(k);
  _joyKeysHeld.clear();
}

// --- Action / rotate buttons (press-and-hold, dispatch keydown on press
// and keyup on release). Sit (Z) is a single-fire toggle — same as the
// keyboard behaviour, so the existing handler already does the right
// thing on a tap. ----------------------------------------------------
function bindHoldButton(btn) {
  const code = btn.dataset.key;
  if (!code) return;
  let active = false;
  const press = (e) => {
    if (active) return;
    active = true;
    btn.classList.add('is-pressed');
    pressKey(code);
    e.preventDefault();
  };
  const release = (e) => {
    if (!active) return;
    active = false;
    btn.classList.remove('is-pressed');
    releaseKey(code);
    e.preventDefault();
  };
  btn.addEventListener('touchstart', press, { passive: false });
  btn.addEventListener('touchend',   release, { passive: false });
  btn.addEventListener('touchcancel', release, { passive: false });
  btn.addEventListener('mousedown',  press);
  btn.addEventListener('mouseup',    release);
  btn.addEventListener('mouseleave', release);
  // Defensive: if the user releases outside the button (touchcancel
  // didn't fire — happens on Safari), make sure we don't leak a held
  // key. The visibilitychange + blur listeners below also catch this.
}

function releaseAllPressed() {
  for (const k of Array.from(PRESSED_KEYS)) releaseKey(k);
  if (_joyTouchId !== null) {
    _joyTouchId = null;
    _joystick?.classList.remove('is-active');
    if (_nub) _nub.style.transform = 'translate(0, 0)';
    _joyKeysHeld.clear();
  }
  // Also clear all .is-pressed classes on action buttons.
  if (_root) {
    for (const b of _root.querySelectorAll('.is-pressed')) b.classList.remove('is-pressed');
  }
}

export function mountWalkTouchHUD() {
  _root = document.getElementById('walk-touch-controls');
  _joystick = document.getElementById('walk-joystick');
  _nub = document.getElementById('walk-joystick-nub');
  if (!_root || !_joystick || !_nub) {
    console.warn('[walk-touch-hud] mount failed — element(s) not in DOM:',
      { root: !!_root, joystick: !!_joystick, nub: !!_nub });
    return;
  }
  console.info('[walk-touch-hud] mounted');

  _joystick.addEventListener('touchstart', joystickStart, { passive: false });
  _joystick.addEventListener('touchmove',  joystickMove, { passive: false });
  _joystick.addEventListener('touchend',   joystickEnd, { passive: false });
  _joystick.addEventListener('touchcancel', joystickEnd, { passive: false });
  // Mouse fallback for desktop testing — drag the nub like a joystick.
  _joystick.addEventListener('mousedown', joystickStart);
  window.addEventListener('mousemove', (e) => {
    if (_joyTouchId === 'mouse') joystickMove(e);
  });
  window.addEventListener('mouseup', (e) => {
    if (_joyTouchId === 'mouse') joystickEnd(e);
  });

  for (const btn of _root.querySelectorAll('.walk-btn, .walk-rot-btn')) {
    bindHoldButton(btn);
  }

  // Safety: if the page loses focus (alt-tab, modal, etc.) clear all
  // held keys so the avatar doesn't keep walking forever.
  window.addEventListener('blur', releaseAllPressed);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllPressed();
  });
}

export function showWalkTouchHUD() {
  if (!_root) {
    console.warn('[walk-touch-hud] show called but root missing');
    return;
  }
  // Belt-and-braces: clear both the attribute AND any inline display.
  // Some earlier code paths might have set display:none directly.
  _root.removeAttribute('hidden');
  _root.style.display = 'block';
  _root.setAttribute('aria-hidden', 'false');
  console.info('[walk-touch-hud] shown');
}

export function hideWalkTouchHUD() {
  if (!_root) return;
  releaseAllPressed();
  _root.style.display = 'none';
  _root.setAttribute('hidden', '');
  _root.setAttribute('aria-hidden', 'true');
}
