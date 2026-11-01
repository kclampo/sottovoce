#!/usr/bin/env bash
# sotto voce — check.sh
#
# Build gate. Four things the spec makes non-negotiable, plus the two syntax
# lessons that already cost a deployed build on a sibling project.
#
#   1. ESM SYNTAX — validate as .mjs. `node --check app.js` returns EXIT 0 on
#      broken module code because the import makes Node bail as CommonJS before
#      it reaches the real error. That shipped a dead build on PosePro 2026-10-27.
#   2. GLUED PUNCTUATION — a patch that eats a newline glues a comment rule onto
#      a closing brace. Same outage.
#   3. §1a THE ID RULE — an id must be a UUID generated at creation, never derived
#      from position/index/array offset. Fail on the positional-id signature.
#   4. §7b DO-NOT-BUILD — streaks, reminders, read receipts, notifications to him,
#      AI prompts, auto-send. Design law, so it gets a scanner, not a note.

set -uo pipefail
cd "$(dirname "$0")" || exit 1
fail=0

echo "== ESM syntax validation =="
for f in *.js; do
  tmp="/tmp/sotto_chk_$$.mjs"
  cp "$f" "$tmp"
  if out=$(node --check "$tmp" 2>&1); then
    echo "  OK   $f"
  else
    echo "  FAIL $f"
    echo "$out" | sed 's/^/       /'
    fail=1
  fi
  rm -f "$tmp"
done

echo "== glued punctuation =="
a=$(grep -nP '[}\]](\x{2500}-\x{257F})' *.js 2>/dev/null || true)
b=$(grep -nP '^}[^\s;),]' *.js 2>/dev/null || true)
hits=$(printf '%s\n%s\n' "$a" "$b" | grep -v '^$' || true)
if [ -n "$hits" ]; then echo "$hits" | sed 's/^/  FAIL /'; fail=1; else echo "  OK   none"; fi

echo "== §1a positional-id gate =="
# The Ember defect: `let n = 0; ++n` and padStart(3,'0') producing ids like
# "deck-001". Inserting one record renumbers every id after it.
# ⚠️ EXCLUDE COMMENT LINES — db.js explains the defect in a comment and would
# otherwise fail its own gate. Same false-positive class as the glued-brace scan.
pos=$(grep -nE '\+\+[a-zA-Z_]+|padStart\(\s*3' *.js 2>/dev/null \
      | grep -viE 'chk|version|byte' \
      | grep -vE '^[^:]+:[0-9]+: *(\*|//|/\*)' || true)
if [ -n "$pos" ]; then
  echo "  ⛔ POSITIONAL-ID SIGNATURE FOUND — ids must be crypto.randomUUID():"
  echo "$pos" | sed 's/^/     /'
  fail=1
else
  echo "  OK   no positional id generation"
fi
if grep -q "crypto.randomUUID" db.js 2>/dev/null; then
  echo "  OK   db.js generates UUIDs"
else
  echo "  FAIL db.js has no crypto.randomUUID()"; fail=1
fi

echo "== §7b do-not-build scan =="
# Comments legitimately NAME the banned features, so match only call-shaped use.
banned='\b(streak|readReceipt|typingIndicator|autoSend|scheduledSend|sendAll|moodLog)\b'
if grep -nEi "$banned" app.js db.js sync.js drive.js 2>/dev/null | grep -vE '^\S+:[0-9]+: *(\*|//|/\*)' ; then
  echo "  ⛔ above: do-not-build feature appears in CODE (not a comment)"
  fail=1
else
  echo "  OK   no banned feature in code"
fi
if grep -qE 'new Notification|Notification\.requestPermission' *.js 2>/dev/null; then
  echo "  ⛔ notifications to him are design law — forbidden"; fail=1
else
  echo "  OK   no notifications"
fi

echo "== required files =="
for f in index.html styles.css app.js db.js drive.js sync.js config.js version.js sw.js manifest.json icon.svg icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png; do
  [ -f "$f" ] && echo "  OK   $f" || { echo "  MISSING $f"; fail=1; }
done

echo "== §0.3 no user data in the repo =="
# Personal names live in .gate-names, which is GITIGNORED — the published repo must
# not carry anyone's name, including inside its own guard. Absent file ⇒ skip.
if [ -f .gate-names ]; then
  names=$(grep -vE '^[[:space:]]*(#|$)' .gate-names | paste -sd'|' -)
  if [ -n "$names" ] && grep -rniE "$names" index.html app.js db.js drive.js sync.js config.js manifest.json README.md 2>/dev/null; then
    echo "  ⛔ personal identifier in shipped source or docs"; fail=1
  else
    echo "  OK   no personal identifiers"
  fi
else
  echo "  --   .gate-names absent; name check skipped"
fi
# an email address, a bearer token or a secret in shipped source is a hard fail
emails=$(grep -rnoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' index.html app.js db.js drive.js sync.js config.js manifest.json 2>/dev/null | grep -v 'googleusercontent.com' || true)
if [ -n "$emails" ]; then echo "  ⛔ email address baked into source:"; echo "$emails" | sed 's/^/     /'; fail=1;
else echo "  OK   no email addresses"; fi
if grep -rniE '(client_secret|refresh_token|Bearer [A-Za-z0-9._-]{20,}|ya29\.)' index.html app.js db.js drive.js sync.js config.js 2>/dev/null; then
  echo "  ⛔ credential material in source"; fail=1
else
  echo "  OK   no secrets or tokens"
fi
# the client ID is app identity, not user data — but it must never be a hardcoded account
if grep -q 'GOOGLE_CLIENT_ID' config.js 2>/dev/null; then echo "  OK   client ID lives in config.js (app identity)"; else echo "  FAIL config.js missing GOOGLE_CLIENT_ID"; fail=1; fi

echo "== version consistency =="
vj=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' version.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
vv=$(grep -oE "'[0-9]+\.[0-9]+\.[0-9]+'" version.js | head -1 | tr -d "'")
echo "  version.js   = $vv"
echo "  version.json = $vj"
[ "$vv" = "$vj" ] && echo "  OK   match" || { echo "  FAIL mismatch"; fail=1; }

echo "== service worker cache =="
grep -nE "^const CACHE" sw.js | sed 's/^/  /'

echo
[ "$fail" -eq 0 ] && echo "PASS — safe to push" || echo "FAIL — do not push"
exit "$fail"
