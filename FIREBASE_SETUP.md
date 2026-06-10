# Deploying AuraLAB to Firebase Hosting (with a login wall)

This app is a static site (no build step). These steps move it onto Firebase
Hosting and put every visitor behind a Firebase Authentication login wall.

> **What the login wall does:** unauthenticated visitors see only the sign-in
> card; the app UI never loads for them.
>
> **What it does *not* do:** it does not make the raw files private. Firebase
> Hosting serves `js/`, `css/`, and `data/` publicly, so a technical user could
> still fetch those paths directly. The app holds no secrets, so this is the
> normal trade-off for a static tool. For true file-level protection, see
> **Hardening** at the bottom.

---

## 1. One-time tooling

```bash
npm install -g firebase-tools      # the Firebase CLI
firebase login                     # opens a browser; sign in with your Google account
```

## 2. Create the project and get the web config

1. Go to <https://console.firebase.google.com> → **Add project**. Give it a name
   (e.g. `auralab`). You do **not** need Google Analytics.
2. In the project, click the **`</>`** (Web) icon to "Add an app". Nickname it
   `auralab-web`. **Do not** check "Firebase Hosting" in that dialog — we do
   hosting from the CLI.
3. It shows a `firebaseConfig = { ... }` block. Copy those values into
   [`js/auth/firebase-config.js`](js/auth/firebase-config.js), replacing the
   `YOUR_*` placeholders.
4. Copy your **Project ID** into [`.firebaserc`](.firebaserc), replacing
   `YOUR_FIREBASE_PROJECT_ID`.

## 3. Turn on sign-in methods

Firebase Console → **Build → Authentication → Get started**, then under
**Sign-in method** enable:

- **Google** — one click, pick a support email. (Powers "Continue with Google".)
- **Email/Password** — enable the first toggle (leave passwordless off).
  (Powers the email + password form.)

## 4. Provision accounts (invite-only)

The login card has **no public sign-up** — that keeps access invite-only.
Create each authorized user yourself:

- Authentication → **Users → Add user** → enter their email + a temporary
  password, OR
- Have them "Continue with Google" once you've added their domain as authorized
  (next step). To restrict Google sign-in to specific people, keep the user list
  curated and remove anyone you didn't invite.

## 5. Authorize your domains

Authentication → **Settings → Authorized domains**. Firebase auto-adds
`localhost`, `*.web.app`, and `*.firebaseapp.com`. **Add** any custom domain you
later attach (step 7). Sign-in only works on listed domains — an unlisted domain
throws `auth/unauthorized-domain`.

## 6. Deploy

```bash
firebase deploy --only hosting
```

Output ends with a **Hosting URL** like `https://auralab.web.app`. Open it — you
should see the login card, and the app only after you sign in.

## 7. (Optional) Custom domain

Hosting → **Add custom domain** → follow the DNS steps. Then add that domain to
**Authorized domains** (step 5) or Google sign-in will fail on it.

---

## Embedding & the "registered domain" question

- **Who may iframe-embed the app** is controlled by the
  `Content-Security-Policy: frame-ancestors` header in
  [`firebase.json`](firebase.json). Edit that list to your exact embed origin
  (e.g. your Google Site). Keep only `'self'` if you serve it standalone.
- **Heads-up on iframes + login:** Google sign-in (popup/redirect) is frequently
  blocked inside a cross-origin iframe by third-party-cookie / storage
  partitioning. With the login wall, prefer opening AuraLAB in its **own tab**.
  The code already falls back from popup → redirect, but some embedded contexts
  still won't complete sign-in.

## Updating after a change

```bash
# 1. bump ?v=NNN in index.html (cache-bust, as always)
# 2. run tests:  node tests/*.test.mjs
firebase deploy --only hosting
```

`*.html` is served `no-cache`, so a new deploy is visible immediately; JS/CSS
revalidate within ~5 min; media caches for a week (see headers in
`firebase.json`).

## Hardening — true file-level privacy (optional, heavier)

If you need the static files themselves unreachable without auth (not just the
UI), the static-hosting login wall is not enough. Serve the app through a gated
backend instead:

- **Cloud Run + Identity-Aware Proxy (IAP):** put the site behind IAP, restricted
  to specific Google accounts / a Workspace domain. Strongest; most setup.
- **Cloud Functions/Run reverse proxy:** a function checks a session cookie /
  ID token before streaming each file. Medium effort.

Both replace "Firebase Hosting serves files directly" with "a server decides
per-request whether you're allowed to see the file." Ask if you want this built.
