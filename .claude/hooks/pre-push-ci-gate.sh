#!/usr/bin/env bash
# Pre-push CI gate (local, this machine only).
#
# Runs the CI step that `npm test` does NOT do — `build:codex` (a tsc
# typecheck) — and blocks the push (PreToolUse deny) if it fails, so a codex
# type error can't redden CI *after* the push.
#
# Wired from .claude/settings.local.json, NOT the committed settings.json, on
# purpose: build:codex's prebuild shells out to `codex app-server generate-ts`,
# so it needs the codex CLI on PATH — which this agent has but a random
# contributor may not. Keeping it local avoids false-blocking teammates.
set -uo pipefail

# The settings matcher is a broad `Bash` (no `if` filter — that would risk
# failing closed and silently skipping the gate). So scope HERE: read the tool
# payload from stdin and bail INSTANTLY unless it is a `git push` — never run
# the ~14s checks on a plain `ls`.
case "$(cat 2>/dev/null)" in
  *"git push"*) : ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" 2>/dev/null || exit 0

deny() {
  # Static reason (no quotes/backslashes/newlines) → JSON-safe without jq.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

if ! npm run build:codex >/tmp/prepush-ci-gate.log 2>&1; then
  deny "Pre-push CI gate: build:codex (tsc) FAILED — CI would go red. Run npm run build:codex (log at /tmp/prepush-ci-gate.log), fix the type error, then push."
fi

# Green: emit nothing, exit 0 → the push proceeds.
exit 0
