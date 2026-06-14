// js/auth/profile-fields.js
// ---------------------------------------------------------------------------
// Single source of truth for validating the three required profile fields
// (Company / Position / Contact number). Imported by BOTH the sign-up flow +
// completion gate (auth-gate.js) and the in-app Profile editor
// (account-modal.js), so the rules can't drift between surfaces.
//
// Field KEYS match the Firestore account-doc field names (company, position,
// contactNumber) so values map straight to saveProfileFields() with no
// renaming. Pure module — no DOM, Node-testable.
// ---------------------------------------------------------------------------

export const PROFILE_FIELDS = ['company', 'position', 'contactNumber'];
export const PROFILE_LIMITS = { company: 120, position: 80, contactNumber: 32 };

/**
 * Validate one field. Returns an error string, or null if valid.
 * Contact number is intentionally LOOSE: strip spaces / - / ( ) and accept an
 * optional leading + plus at least 6 digits. No country-format enforcement, no
 * autocorrect — the project bans "did you mean…" on technical fields.
 */
export function validateProfileField(name, raw) {
  const v = (raw || '').trim();
  if (name === 'company')  return v.length >= 2 ? null : 'Enter your company name.';
  if (name === 'position') return v.length >= 2 ? null : 'Enter your position or job title.';
  if (name === 'contactNumber') {
    if (!v) return 'Enter a contact number.';
    const digits = v.replace(/[\s\-().]/g, '');
    return /^\+?\d{6,}$/.test(digits) ? null : 'Enter a valid contact number (digits, spaces and + only).';
  }
  return null;
}

/**
 * Validate all three via a getValue(name) accessor (so callers can read from
 * any DOM prefix or a plain object).
 * @returns {{ ok: boolean, values: object, errors: object }}
 */
export function validateProfileGroup(getValue) {
  const errors = {};
  const values = {};
  for (const name of PROFILE_FIELDS) {
    values[name] = (getValue(name) || '').trim();
    const err = validateProfileField(name, values[name]);
    if (err) errors[name] = err;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}
