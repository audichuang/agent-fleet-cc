#!/usr/bin/env bash
# scripts/smoke.sh — automated preflight for the Phase 7 smoke checklist.
#
# Validates the parts of the plugin that don't need a live agent: binary
# resolution, plugin manifests, tests, and CLI surface. Human-driven steps
# (Claude Code / Codex CLI / agy interactive sessions, OAuth) live in
# docs/SMOKE.md.
#
# Exits 0 only if every check passes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RED="\033[31m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RST="\033[0m"

pass=0
fail=0
warn=0

section() {
  printf "\n${CYAN}== %s ==${RST}\n" "$1"
}
ok() { printf "${GREEN}OK${RST}    %s\n" "$1"; pass=$((pass + 1)); }
no() { printf "${RED}FAIL${RST}  %s\n" "$1"; fail=$((fail + 1)); }
note() { printf "${YELLOW}WARN${RST}  %s\n" "$1"; warn=$((warn + 1)); }

section "Environment"
node_version="$(node --version 2>/dev/null || true)"
if [[ -z "$node_version" ]]; then
  no "node not on PATH"
else
  ok "node $node_version"
fi

if command -v agy >/dev/null 2>&1; then
  agy_version="$(agy --version 2>/dev/null | head -1 || true)"
  if [[ -n "$agy_version" ]]; then
    ok "agy $agy_version"
  else
    note "agy on PATH but --version returned nothing"
  fi
else
  no "agy not on PATH — install from https://antigravity.google/download"
fi

section "Plugin manifests"
for f in plugin.json .claude-plugin/plugin.json .claude-plugin/marketplace.json \
         .codex-plugin/plugin.json .agents/plugins/marketplace.json \
         agents/openai.yaml SKILL.md; do
  if [[ -f "$ROOT/$f" ]]; then
    ok "$f present"
  else
    no "$f missing"
  fi
done

# Byte-identical canonical plugin.json across hosts
if cmp -s "$ROOT/plugin.json" "$ROOT/.claude-plugin/plugin.json" \
       && cmp -s "$ROOT/plugin.json" "$ROOT/.codex-plugin/plugin.json"; then
  ok "plugin.json byte-identical across all three host manifests"
else
  no "plugin.json drift across hosts — re-sync the three copies"
fi

section "agy plugin validate"
if command -v agy >/dev/null 2>&1; then
  if agy plugin validate "$ROOT" >/tmp/agy-validate.$$ 2>&1; then
    if grep -q '\[ok\]' /tmp/agy-validate.$$; then
      ok "agy plugin validate reports ok"
      grep -E 'processed|skipped' /tmp/agy-validate.$$ | sed 's/^/      /'
    else
      no "agy plugin validate did not report [ok]"
      cat /tmp/agy-validate.$$
    fi
  else
    no "agy plugin validate exited non-zero"
    cat /tmp/agy-validate.$$
  fi
  rm -f /tmp/agy-validate.$$
else
  note "agy missing — skipping plugin validate"
fi

section "Tests"
if (cd "$ROOT" && npm test --silent 2>&1 | tail -8); then
  if (cd "$ROOT" && npm test --silent 2>&1 | grep -q 'fail 0'); then
    ok "npm test reports 0 failures"
  else
    no "npm test reports failures"
  fi
fi

section "Standalone CLI surface"
bin="$ROOT/bin/antigravity.mjs"
if node "$bin" --version 2>/dev/null | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  ok "bin --version prints semver"
else
  no "bin --version did not print semver"
fi

if node "$bin" help review 2>&1 | grep -Eiq '(flag|usage)'; then
  ok "bin help review prints flag summary"
else
  no "bin help review missing flag summary"
fi

# Capture node output to a variable first. `if cmd | grep` would have
# pipefail propagate node's exit 2/127 and skip the grep — bin already
# correctly exits non-zero on these cases, so the diagnostic exit code
# would shadow our actual check.
unknown_out="$(node "$bin" notacommand 2>&1 || true)"
if grep -Eiq 'unknown command|did you mean' <<<"$unknown_out"; then
  ok "bin rejects unknown command with hint"
else
  no "bin does not reject unknown command properly"
fi

install_out="$(AGY_BIN=/nonexistent node "$bin" setup 2>&1 || true)"
if grep -q 'antigravity.google/download' <<<"$install_out"; then
  ok "bin surfaces install URL when AGY_BIN missing"
else
  no "bin does not surface install URL when AGY_BIN missing"
fi

section "Banned strings"
# Exclude this script itself (it lists the banned patterns as data) and any test
# fixtures that legitimately reference them for compatibility checks.
banned=$(grep -rE 'gemini --acp|--experimental-acp|acp-client|acp-broker|stream-output\.mjs|thinking\.mjs|/gemini:' \
         "$ROOT/scripts" "$ROOT/commands" "$ROOT/agents" "$ROOT/.agents" "$ROOT/SKILL.md" \
         "$ROOT/README.md" "$ROOT/docs/INSTALL.md" 2>/dev/null \
         | grep -v '\.test\.mjs' \
         | grep -v 'scripts/smoke\.sh' || true)
if [[ -z "$banned" ]]; then
  ok "no banned ACP / streaming / gemini-slash strings in shipped code"
else
  no "banned strings found:"
  printf "%s\n" "$banned"
fi

section "Summary"
printf "pass: ${GREEN}%d${RST}  fail: ${RED}%d${RST}  warn: ${YELLOW}%d${RST}\n" "$pass" "$fail" "$warn"
if (( fail > 0 )); then
  exit 1
fi
exit 0
