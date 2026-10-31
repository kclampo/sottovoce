# sotto voce

*A song shared between two people.*

A two-person notebook. She writes; things she chooses to send reach him. Nothing else
happens — no feed, no metrics, no audience.

**Full spec:** `NOTEBOOK_SPEC.md` (in the assistant's memory store). This file is the
operator's guide. Where the two disagree, the spec wins.

---

## What it is, in one line

**A sender that keeps drafts.** Not a notes app with a share button — a writing screen with
a send button, and a quiet shelf behind it for the things she didn't send.

The draft state exists so hesitation has somewhere to sit. That is the entire product.

---

## The two screens

**The score** — one continuous chronological list. One day = one system. A single hairline
runs down the left edge; that spine is the only thing the layout is built around:

| Glyph | Meaning |
|---|---|
| **On the line**, filled, with a stem | **sent** — it was played; inked into the score |
| **Off the line**, hollow, lighter | **draft** — pencilled beside the stave; it made no sound |

⚠️ That distinction is never carried by colour alone. It survives greyscale, colour
blindness and a cracked screen.

**The editor** — full-height plain text. No toolbar, no formatting, no preview. Autosave at
500 ms, on blur, and on tab hide. A sent entry opens read-only and says when it was sent.

⛔ There is no third screen. Settings is a panel, not a place.

---

## Who logs in — and what the repo knows

**Nothing about any person is in this repo.** No name, no email address, no account, no
token. `check.sh` fails the build if one appears.

**Every user authenticates into their own Google account on their own device.** Each person
signs into their own account; the token is theirs, held in their browser's memory for about
an hour, and the notes land in their own Drive. The app has no concept of a "user" beyond
whoever is signed in right now.

⛔ **No Gmail.** The app never requests a Gmail scope and cannot read anyone's email. The
only scope is `drive.file`, which sees **only files this app itself created** — not her
other documents, not her photos, not her mail.

---

## First-run setup — two steps, both once

Neither step is done by the person using the app, and neither involves anybody's
credentials.

### 1. Register the app with Google (once, by whoever ships this)

This is **app registration, not account setup.** Google has no backend here to identify the
caller, so the application needs a public name badge — a *client ID*. That is all it is.

1. **console.cloud.google.com** → new project, e.g. `sotto-notebook`
2. **APIs & Services → Library** → enable **Google Drive API**
   — ⛔ Drive only. Do not enable Gmail, and do not add a Gmail scope.
3. **OAuth consent screen** → User type **External**
   - App name: **neutral. No personal names, no household identifiers.**
   - Scopes: add **exactly one** — `https://www.googleapis.com/auth/drive.file`
4. **Publishing status → Publish app (In production)**
   - `drive.file` is a **non-sensitive** scope, so no verification review is normally
     required.
   - ⚠️ If Google *does* demand review, fall back to **Testing** with 2 test users. For a
     two-person app that is functionally identical, at the cost of a one-time
     "unverified app → Advanced → proceed" click and 7-day token expiry.
5. **Credentials → Create credentials → OAuth client ID → Web application**
   - Authorized JavaScript origins: your Pages origin only —
     e.g. `https://USERNAME.github.io` (**origin only — no path, no trailing slash**)
     plus `http://localhost:8795` for dev.
   - **No redirect URI needed.** This is a token flow, not a redirect flow.

Paste the resulting client ID into **`config.js`**:

```js
export const GOOGLE_CLIENT_ID = '1234…apps.googleusercontent.com';
```

That is the only line to change, and it is the only thing that ships. It is a public
identifier — putting it in the repo is correct and expected, and it exposes nothing.

**The client ID is never shown in the app's UI.** The user installs the app, taps
**Connect Google Drive**, and signs into their own account.

**If the client ID is left empty the app still works** — writing, drafting, sending and
export all function. Only Drive sync is absent, and Settings says so in plain English.

### 2. Share the outbox folder — once, forever, from her Drive

After her first Send: open the Drive app → long-press the **`outbox`** folder → **Share** →
add his email as **Viewer**.

⛔ Do **not** share `notes/`. That folder is never shareable and contains every draft.

---

## ⛔ There is no client secret

- A browser token flow has **no client secret**. Never create one.
- The access token is held **in memory only** — never localStorage, never a cookie.
- No API keys anywhere in the client.
- No account, email or identifier of any kind is baked into these files.

---

## Run it

No build step. No dependencies. No backend of any kind.

```bash
cd sottovoce
python3 -m http.server 8795
# open http://127.0.0.1:8795/
```

State lives in **IndexedDB**. Nothing leaves the device except what she explicitly sends.

⚠️ **During development the service worker will serve stale files.** Before testing a
change: DevTools → Application → Service Workers → Unregister, then clear Cache Storage.
This is not optional — a cache-first SW with an unchanged cache name serves the old app
forever and it looks like your fix did nothing.

---

## Verify before any push

```bash
bash check.sh
```

Four gates, and each one exists because something went wrong somewhere:

| Gate | Why |
|---|---|
| **ESM syntax** — every `.js` validated as `.mjs` | `node --check app.js` returns **exit 0 on broken module code**, because the `import` makes Node bail as CommonJS before reaching the real error. That shipped a dead build on a sibling project. |
| **Glued punctuation** | A patch that eats a newline glues a comment rule onto a closing brace → module fails to parse → **no listeners attach** → the app renders and every button is dead. |
| **§1a positional-id** | Ids must be `crypto.randomUUID()`. Positional ids renumber on insert, so stored state keyed by old ids silently points at different records. Nothing throws. |
| **§7b do-not-build** | Streaks, reminders, read receipts, notifications, auto-send are scanned for in **code**, not just documented. |

It also checks version consistency, required files, and that no personal identifier appears
in shipped source.

---

## Data model

```
Entry {
  id            uuid-v4, assigned at creation, IMMUTABLE
  body          plain text
  created_at    ISO-8601 UTC
  updated_at    ISO-8601 UTC
  state         'draft' | 'sent'
  sent_at       ISO-8601 | null
  rev           integer, bumped on every edit while draft
  drive_file_id string | null
  deleted       boolean   (tombstone — never a hard delete)
}
```

- **Sent entries are frozen.** The body cannot be edited — it is the record of what she
  actually sent.
- **No tags, no folders, no titles.** The display title is the first line, derived at render
  time, never stored.
- **Union merge on id.** Two devices writing offline produce two independent files. No
  conflict. If two devices edit the same draft offline the higher `rev` wins and the loser
  is preserved as a new entry — **text is never silently discarded.**

---

## Drive layout

```
HER GOOGLE DRIVE
└── sotto voce/            created by the app; the only thing drive.file can see
    ├── notes/<id>.json    every entry, draft or sent. NEVER shared.
    ├── outbox/<id>.md     written ONLY on explicit Send. The only shareable folder.
    └── meta/device.json   device id, cursor
```

**The split is the privacy guarantee.** Her drafts are structurally unreachable because they
never enter a shared folder.

**Her Google account, always.** If this is ever signed in with his account on her phone, he
can read every unsent draft and the entire design collapses into surveillance. Installing
the PWA and walking her through sign-in is help; signing in as her is not.

---

## Who can read what

| | Who |
|---|---|
| Her unsent drafts | Her, and Google. Nobody else. |
| What she sends | Her, him, Google. |
| His app reading her private folder | **No** — `drive.file` cannot see files it did not create. |

⚠️ **The honest caveat, stated to her and not hidden:** Google stores the drafts, so Google
can technically read them. There is no client-side encryption in v1. **Do not claim
"encrypted" or "sealed" anywhere in the UI** — the copy says *private to you*, which is true.

---

## ⛔ Do not build

Design law, not a backlog. Each of these would break the mechanism the app exists to protect.

| Never build | Because |
|---|---|
| Streaks, "days written", word counts | turns feeling into a performance metric |
| Reminders or nudges to write | an obligation is not an outlet |
| Read receipts, "seen", typing indicators | reintroduces the audience that ruins it |
| Notifications to him on send | he reads at his leisure — that *is* the point |
| AI prompts, mood logging, weekly reports | instrumentation of private thought |
| Auto-send, scheduled send, "share all" | sending must stay one deliberate act |
| Ordering by "important" | chronological only; a journal has no feed |

**The test for any new feature: does it add an observer, a metric, or a deadline?** If yes,
it is out.

---

## Voice

Musical in the atmosphere, literal in the controls.

✅ Empty shelf: *"Nothing yet. Hum something."* · After a send: *"Played."*
✅ The name is always rendered *sotto voce* — lowercase italic, like a score marking.

⛔ Buttons say **Send** and **New**. Never *Play*, *Perform* or *Resound*.
⛔ Settings and every error message are plain English. That is where she goes when something
is wrong; metaphor there costs her the thing she came for.

**The app makes no sound.** It is *sotto voce* literally — the metaphor is purely visual.

---

## Status — v1.0.0

Built 2026-10-31 to `NOTEBOOK_SPEC.md`. Verified in a real browser:

- [x] Create → editor opens with the cursor live, writing starts immediately
- [x] Autosave debounce (500 ms) writes to IndexedDB
- [x] Ids are UUIDs, never positional
- [x] Score renders inked (sent) vs pencilled (draft), differentiated by position and fill,
      never by colour alone
- [x] Days group into systems; no "Today"/"Yesterday"; the staff is the only horizontal rule
- [x] Send freezes the entry, writes the outbox copy, opens a pre-filled `mailto:`
- [x] Long bodies are truncated in the mail link **and say where the full text is**
- [x] Export JSON (full fidelity) and Markdown (human archive)
- [x] Import with union merge and a recovered-loser path
- [x] Zero console errors on load, write, send, export

**Not yet verified on a device** — needs a real phone for the service worker, offline write,
and the Google token flow. Those are in the spec's definition-of-done and are the next test.

**Known gap:** `meta/device.json` is described in the spec and the tree is created, but the
device id is not yet written to it. Not load-bearing for v1 — nothing reads it yet.
