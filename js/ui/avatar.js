// js/ui/avatar.js
// ---------------------------------------------------------------------------
// The signed-in user's identity avatar — the ONE intentionally-round element in
// AuraLAB's otherwise-square chrome. Used at three sizes (24px header chip,
// 52px Account modal, and the coloured fallback disc) so it reads as one
// identity object scaled, not three different avatars.
//
// Lives in its own module so both account-menu.js (chip) and account-modal.js
// can import it without a circular dependency (the menu imports the modal).
// ---------------------------------------------------------------------------

// Muted, desaturated disc palette — deliberately NOT the saturated data-vis
// colours, so the disc reads as a quiet identity token and never competes with
// --data-green / --data-red which carry meaning. Distinguishable by lightness +
// warm/cool axis (deuteranopia-safe); disc colour is decorative only.
const DISC_SWATCHES = ['#3d6fa5', '#4a7c59', '#8a5a9e', '#a56a3d', '#3d8a8a', '#9e4a5a'];

// Human-facing display name: displayName → email local-part → 'User'.
export function displayNameOf(user) {
  const name = (user?.displayName || '').trim();
  if (name) return name;
  const email = (user?.email || '').trim();
  if (email) return email.split('@')[0];
  return 'User';
}

// Single uppercase initial for the fallback disc.
export function initialOf(user) {
  const base = (user?.displayName || user?.email || '?').trim();
  return base[0]?.toUpperCase() || '?';
}

// Deterministic disc colour from the fixed palette — same user always gets the
// same swatch (stable across renders), derived from email then displayName.
export function discColor(user) {
  const s = (user?.email || user?.displayName || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return DISC_SWATCHES[h % DISC_SWATCHES.length];
}

/**
 * Build an avatar <span>. Uses the user's photoURL when present (Google
 * accounts), falling back to a coloured initial disc — also on image load
 * error (a broken photoURL must not leave an empty circle).
 * @param {object} user  the published auth snapshot (window.__auralabAuth.user)
 * @param {string} extraClass  optional extra class (e.g. size variant)
 * @returns {HTMLSpanElement}
 */
export function buildAvatar(user, extraClass = '') {
  const span = document.createElement('span');
  span.className = ('avatar-disc ' + extraClass).trim();
  span.setAttribute('aria-hidden', 'true');

  const paintInitial = () => {
    span.classList.add('is-initial');
    span.textContent = initialOf(user);
    span.style.background = discColor(user);
  };

  if (user?.photoURL) {
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';   // Google photo URLs 403 with a referrer
    img.onerror = () => { span.textContent = ''; paintInitial(); };
    img.src = user.photoURL;
    span.appendChild(img);
  } else {
    paintInitial();
  }
  return span;
}
