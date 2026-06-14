// js/auth/firebase-db.js
// ---------------------------------------------------------------------------
// Cloud Firestore wiring for AuraLAB — the accounts database.
//
// Owned by the auth layer (NOT by AccountLAB) so there is exactly ONE Firebase
// app instance: auth-gate.js creates the app + auth, then calls initDb(app)
// here. A second initializeApp()/getFirestore() elsewhere would be a separate
// instance with a separate (unauthenticated) context — getDb() returns the
// shared one.
//
// Phase 0 (foundation): on sign-in we upsert an `accounts/{uid}` document that
// mirrors the Auth identity and carries the profile + entitlement fields. The
// client may only seed defaults (tier:'free', status:'active') and later write
// its OWN profile fields — never tier/status. That boundary is ENFORCED by the
// Firestore security rules (firestore.rules), not by this code; the code just
// stays within them.
//
// Trust model (operator decision 2026-06-14): rules-only / free Spark plan.
// `status` and `tier` are honoured by the (static) client, so "suspend" is a
// respected lock, not an un-bypassable vault. Upgrade path to tamper-proof
// custom claims (Cloud Functions) is documented in the account-tier plan.
// ---------------------------------------------------------------------------

import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
  collection, query, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _db = null;

/** Initialise Firestore against the shared Firebase app. Idempotent. */
export function initDb(app) {
  if (!_db && app) _db = getFirestore(app);
  return _db;
}

/** The shared Firestore instance, or null if initDb() hasn't run. */
export function getDb() { return _db; }

const ACCOUNTS = 'accounts';

/** Reference to an account document. */
export function accountRef(uid) {
  return _db && uid ? doc(_db, ACCOUNTS, uid) : null;
}

const PROFILE_KEYS = ['company', 'position', 'contactNumber'];

/** True when all required profile fields are filled (trimmed non-empty). */
export function isProfileComplete(p) {
  return !!p && PROFILE_KEYS.every((k) => String(p[k] ?? '').trim() !== '');
}

/**
 * List all account documents, most-recently-active first. ADMIN-ONLY in
 * practice — the Firestore rules only let an admin read other users' docs, so a
 * non-admin's query rejects. Used by AccountLAB.
 * @param {number} [max] cap (default 200)
 * @returns {Promise<object[]>} account data objects (empty on error / no DB)
 */
export async function listAccounts(max = 200) {
  if (!_db) return [];
  try {
    const q = query(collection(_db, ACCOUNTS), orderBy('lastActiveAt', 'desc'), limit(max));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
  } catch (e) {
    console.warn('[firebase-db] listAccounts failed:', e);
    throw e;   // let AccountLAB show an error state (e.g. permission denied / offline)
  }
}

// ---------------------------------------------------------------------------
// Per-user ROOM LIBRARY (the user's "work"). MULTI-project / multi-room: each
// saved room is one doc at accounts/{uid}/rooms/{roomId} holding a full
// serializeProject() blob, grouped into projects by `projectName`. Stored OFF
// the account doc so listAccounts() (the AccountLAB table) stays cheap. Explicit
// Save only (no autosave). Admins can READ any user's rooms (read-only viewer)
// but the rules forbid admin writes. accounts/{uid}/scene/current is now a tiny
// POINTER ({ lastRoomId }) so boot can restore the last-opened room.
// ---------------------------------------------------------------------------

const ROOMS = 'rooms';

// Conservative soft cap below Firestore's 1 MB doc limit — leaves margin for
// map overhead vs raw JSON. A room over this fails Save explicitly (never
// silently truncated). Exported so the caller can word the error.
export const SCENE_SOFT_LIMIT_BYTES = 700 * 1024;

/** Byte size of a scene blob as JSON (pure; used by the Save size guard). */
export function sceneBlobSize(blob) {
  try { return JSON.stringify(blob).length; } catch (_) { return Infinity; }
}

/**
 * List all of a user's saved rooms. Admin may pass ANOTHER user's uid (the
 * read-only viewer — rules permit admin reads). Lets getDocs THROW on
 * offline/denied so the boot flow can tell new-user from offline.
 * @returns {Promise<object[]>} room entries (each { id, projectName, roomName, scene, savedAt })
 */
export async function listRoomsForUser(uid) {
  if (!_db || !uid) return [];
  const snap = await getDocs(collection(_db, ACCOUNTS, uid, ROOMS));
  return snap.docs.map((d) => d.data());
}

/**
 * Save (create or overwrite) one room. Returns a result object, never throws.
 * Codes: 'ok' | 'no-db' | 'serialize' | 'too-large' | (firebase code) | 'write-failed'.
 * @param {object} entry { id, projectName, roomName, scene, savedAt }
 */
export async function saveRoomForUser(uid, entry) {
  if (!_db || !uid || !entry?.id) return { ok: false, code: 'no-db' };
  const size = sceneBlobSize(entry.scene);
  if (!Number.isFinite(size)) return { ok: false, code: 'serialize' };
  if (size > SCENE_SOFT_LIMIT_BYTES) return { ok: false, code: 'too-large', size };
  try {
    await setDoc(doc(_db, ACCOUNTS, uid, ROOMS, entry.id), {
      id: entry.id,
      projectName: entry.projectName ?? null,
      roomName: entry.roomName ?? '',
      scene: entry.scene,
      formatVersion: (entry.scene && typeof entry.scene.formatVersion === 'number') ? entry.scene.formatVersion : 0,
      savedAt: entry.savedAt ?? null,
      updatedAt: serverTimestamp(),
      savedFrom: 'web',
    });
    return { ok: true };
  } catch (e) {
    console.warn('[firebase-db] saveRoomForUser failed:', e);
    return { ok: false, code: e?.code || 'write-failed' };
  }
}

/** Delete one room. Returns a result object, never throws. */
export async function deleteRoomForUser(uid, roomId) {
  if (!_db || !uid || !roomId) return { ok: false, code: 'no-db' };
  try { await deleteDoc(doc(_db, ACCOUNTS, uid, ROOMS, roomId)); return { ok: true }; }
  catch (e) { console.warn('[firebase-db] deleteRoomForUser failed:', e); return { ok: false, code: e?.code || 'delete-failed' }; }
}

/** Save the "last-opened room" pointer (accounts/{uid}/scene/current). Fire-and-forget. */
export async function saveLastRoomPointer(uid, roomId) {
  if (!_db || !uid) return;
  try { await setDoc(doc(_db, ACCOUNTS, uid, 'scene', 'current'), { lastRoomId: roomId || null, updatedAt: serverTimestamp() }); }
  catch (e) { console.warn('[firebase-db] saveLastRoomPointer failed:', e); }
}

/** Read the "last-opened room" pointer, or null. Also returns any legacy
 * Phase-1 single-scene `blob` (for the one-time migration shim in boot). */
export async function loadLastRoomPointer(uid) {
  if (!_db || !uid) return { lastRoomId: null, legacyBlob: null };
  const snap = await getDoc(doc(_db, ACCOUNTS, uid, 'scene', 'current'));   // may THROW
  if (!snap.exists()) return { lastRoomId: null, legacyBlob: null };
  const d = snap.data() || {};
  return { lastRoomId: d.lastRoomId ?? null, legacyBlob: d.blob ?? null };
}

/** Read an account document's data, or null (missing / Firestore unavailable). */
export async function fetchAccount(uid) {
  if (!_db || !uid) return null;
  try {
    const snap = await getDoc(doc(_db, ACCOUNTS, uid));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn('[firebase-db] fetchAccount failed:', e);
    return null;
  }
}

/**
 * Write the user's own profile fields (company / position / contactNumber) and
 * recompute profileComplete. This is an UPDATE — the account doc must already
 * exist (it's seeded by upsertAccountOnSignIn on first sign-in). Stays within
 * the owner-writable allow-list in firestore.rules (never touches tier/status).
 * Used by the sign-up completion gate AND the in-app Profile editor.
 * @returns {Promise<boolean>} success
 */
export async function saveProfileFields(uid, { company, position, contactNumber } = {}) {
  if (!_db || !uid) return false;
  const fields = {
    company: String(company ?? '').trim(),
    position: String(position ?? '').trim(),
    contactNumber: String(contactNumber ?? '').trim(),
  };
  try {
    await updateDoc(doc(_db, ACCOUNTS, uid), {
      ...fields,
      profileComplete: isProfileComplete(fields),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn('[firebase-db] saveProfileFields failed:', e);
    return false;
  }
}

/**
 * Upsert the signed-in user's account document on sign-in.
 *   • Missing → create with identity mirror + profile fields (from `seedProfile`
 *     if a new registration supplied them, else empty) + profileComplete +
 *     default entitlement (tier:'free', status:'active').
 *   • Exists  → refresh the identity mirror + lastActiveAt only. Never touches
 *     tier / status / profile fields (owned by the profile form + admin console).
 * Returns the account data so the caller can gate on profileComplete with no
 * extra read. Returns null if Firestore isn't initialised; THROWS on a Firestore
 * error (the caller decides whether to trap or boot).
 * @param {object} user
 * @param {{company,position,contactNumber}|null} [seedProfile] sign-up values
 * @returns {Promise<object|null>} the account data (or null if no DB)
 */
export async function upsertAccountOnSignIn(user, seedProfile = null) {
  if (!_db || !user?.uid) return null;
  const ref = doc(_db, ACCOUNTS, user.uid);
  const snap = await getDoc(ref);
  const identity = {
    email:       (user.email || '').toLowerCase(),
    displayName: user.displayName || '',
    photoURL:    user.photoURL || '',
  };
  if (!snap.exists()) {
    const profile = {
      company:       String(seedProfile?.company ?? '').trim(),
      position:      String(seedProfile?.position ?? '').trim(),
      contactNumber: String(seedProfile?.contactNumber ?? '').trim(),
    };
    const data = {
      uid: user.uid,
      ...identity,
      ...profile,
      profileComplete: isProfileComplete(profile),
      // Entitlement + lifecycle — client may only seed these defaults; all
      // later writes to tier/status come from the admin console (rules-gated).
      tier: 'free',
      status: 'active',
      createdAt:    serverTimestamp(),
      updatedAt:    serverTimestamp(),
      lastActiveAt: serverTimestamp(),
    };
    await setDoc(ref, data);
    return data;
  }
  const data = snap.data();
  // A deleted account is write-frozen by the rules — attempting the routine
  // identity/lastActiveAt refresh would be DENIED and throw. Skip it and return
  // the data as-is so the boot flow can route the user to the deleted gate.
  if (data?.status === 'deleted') return data;
  await updateDoc(ref, {
    ...identity,
    lastActiveAt: serverTimestamp(),
    updatedAt:    serverTimestamp(),
  });
  return data;
}

/**
 * Self-service account closure (SOFT delete): flip the account doc to
 * status:'deleted' + stamp deletedAt (server time). The record is RETAINED so an
 * admin still sees the account + its deletion date in AccountLAB. This is the
 * MANDATORY tier of deletion — the Auth-credential removal (deleteUser) is a
 * separate best-effort step in auth-gate. Stays within the onlySelfDelete()
 * rule (only status/deletedAt/updatedAt change; never tier/profile).
 * @returns {Promise<boolean>} success
 */
export async function deleteOwnAccount(uid) {
  if (!_db || !uid) return false;
  try {
    await updateDoc(doc(_db, ACCOUNTS, uid), {
      status: 'deleted',
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn('[firebase-db] deleteOwnAccount failed:', e);
    return false;
  }
}
