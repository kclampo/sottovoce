/*
 * sotto voce — config.js
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS APP IDENTITY. IT IS NOT USER DATA.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * GOOGLE_CLIENT_ID is the app's public name badge with Google. It answers one
 * question — "which application is asking?" — and it identifies the SOFTWARE,
 * not a person. It contains no name, no email, no account, no secret.
 *
 * ⛔ What is never in this repo: access tokens, refresh tokens, client secrets,
 *    anybody's email address, anybody's account. Those either do not exist
 *    (there is no client secret for a browser token flow) or are held in memory
 *    at runtime and never written down.
 *
 * ⚠️ Is it safe to commit? Yes — Google designs browser client IDs to be public.
 *    They ship in every web app's JavaScript bundle by design. The security of
 *    this app comes from the OAuth consent flow and the drive.file scope, not
 *    from hiding this string. Publishing it lets a stranger build their own
 *    client against this project; it does not let them read one byte of anyone's
 *    notes, because drive.file can only see files the app itself created, under
 *    the account that authenticated.
 *
 * WHY IT HAS TO EXIST AT ALL
 * A static site has no backend to hold a secret, so Google has no way to know
 * who is calling unless the app is registered once and presents this ID. It is
 * the only prerequisite for Drive sync, and it is a one-time step by whoever
 * ships the app — NOT something each user does, and NOT something the person
 * using it ever sees or fills in.
 *
 * FILL THIS IN ONCE, THEN NEVER AGAIN:
 *   1. console.cloud.google.com → new project
 *   2. Enable APIs & Services → Google Drive API      (Drive only — no Gmail)
 *   3. OAuth consent screen → External → add exactly one scope:
 *        https://www.googleapis.com/auth/drive.file
 *   4. Publishing status → Publish app (in production)
 *   5. Credentials → Create credentials → OAuth client ID → Web application
 *      Authorized JavaScript origins: https://<user>.github.io   (origin only)
 *      No redirect URI. No client secret.
 *   6. Paste the value below.
 *
 * Leave it empty and the app still works completely — writing, drafting, sending,
 * export — everything except Drive sync. Settings will say so in plain English.
 */

export const GOOGLE_CLIENT_ID = '';

/**
 * Recipient is NOT baked in. It is set on the device, by the person using it,
 * and stored in IndexedDB. The repo ships knowing nothing about who anybody is.
 */
