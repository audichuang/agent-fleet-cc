#!/usr/bin/env node
// antigravity-plugin — standalone CLI: `npx antigravity-plugin <command>`.
// Dispatches to scripts/commands/<name>.mjs so behaviour is identical to
// the Claude Code and Codex CLI hosts.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPT_ROOT = process.env.ANTIGRAVITY_SCRIPT_ROOT
  ? resolve(process.env.ANTIGRAVITY_SCRIPT_ROOT)
  : resolve(ROOT, 'scripts', 'commands');

const INSTALL_URL = 'https://antigravity.google/download';
const KNOWN = ['setup', 'review', 'adversarial-review', 'rescue', 'task', 'image', 'status', 'result', 'cancel'];
// Commands that shell out to `agy`. status/result/cancel only read disk state.
const AGY_REQUIRED = new Set(['setup', 'review', 'adversarial-review', 'rescue', 'task', 'image']);

/** Help text per command — flag/positional contract. */
const COMMAND_HELP = {
  setup:
    'antigravity-plugin setup — one-time OAuth wizard.\n\n' +
    'Usage: antigravity-plugin setup\n\n' +
    'Runs `agy --print` once so the OAuth URL surfaces. Idempotent.\n' +
    'Exits non-zero if `agy` is not on PATH.',
  review:
    'antigravity-plugin review — review uncommitted changes or a branch diff.\n\n' +
    'Usage: antigravity-plugin review [flags]\n\n' +
    'Flags:\n' +
    '  --base <ref>            base ref for a branch diff\n' +
    '  --scope <auto|working-tree|branch>\n' +
    '  --background            fork a worker, return immediately\n' +
    '  --wait                  block until the job finishes\n' +
    '  --continue              resume the last review conversation\n' +
    '  --conversation <id>     resume a specific conversation\n' +
    '  --json                  emit JSON instead of markdown\n' +
    '  --cwd <path>            override working directory',
  'adversarial-review':
    'antigravity-plugin adversarial-review — strict, structured (JSON) review.\n\n' +
    'Usage: antigravity-plugin adversarial-review [flags]\n\n' +
    'Flags:\n' +
    '  --base <ref>            base ref for a branch diff\n' +
    '  --scope <auto|working-tree|branch>\n' +
    '  --model <id>            model to use\n' +
    '  --no-sandbox            disable the read-only sandbox (not recommended)\n' +
    '  --json                  emit JSON instead of markdown\n' +
    '  --cwd <path>            override working directory',
  rescue:
    'antigravity-plugin rescue — delegate a free-form task to agy.\n\n' +
    'Usage: antigravity-plugin rescue <prompt> [flags]\n\n' +
    'Flags:\n' +
    '  --background, --wait, --resume, --continue, --fresh\n' +
    '  --conversation <id>     resume a specific conversation\n' +
    '  --add-dir <path>        extra workspace dir (repeatable)\n' +
    '  --model <id>            forward-compat, currently ignored\n' +
    '  --json                  emit JSON instead of markdown\n' +
    '  --cwd <path>            override working directory',
  task:
    'antigravity-plugin task — free-form prompt with state tracking.\n\n' +
    'Usage: antigravity-plugin task <prompt> [flags]\n' +
    'Defaults to BACKGROUND. Use --foreground to inline, --wait to block.\n\n' +
    'Flags:\n' +
    '  --wait, --foreground, --continue\n' +
    '  --conversation <id>     resume a specific conversation\n' +
    '  --add-dir <path>        extra workspace dir (repeatable)\n' +
    '  --json                  emit JSON\n' +
    '  --cwd <path>            override working directory',
  image:
    'antigravity-plugin image — generate an image with agy (Imagen).\n\n' +
    'Usage: antigravity-plugin image <description> [flags]\n' +
    'Runs in the foreground and returns the saved image path.\n\n' +
    'Flags:\n' +
    '  --name <id>             ask agy to save the image under this name\n' +
    '  --output <path>         copy the generated file to this path\n' +
    '  --add-dir <path>        extra workspace dir (repeatable)\n' +
    '  --json                  emit JSON\n' +
    '  --cwd <path>            override working directory',
  status:
    'antigravity-plugin status — list active/recent jobs or inspect one.\n\n' +
    'Usage: antigravity-plugin status [<job-id>] [flags]\n\n' +
    'Flags:\n' +
    '  --wait                  block until terminal state\n' +
    '  --timeout-ms <ms>       override wait timeout (default 15m)\n' +
    '  --json                  emit JSON instead of markdown\n' +
    '  --cwd <path>            override working directory',
  result:
    "antigravity-plugin result — fetch a finished job's stored output.\n\n" +
    'Usage: antigravity-plugin result [<job-id>] [flags]\n\n' +
    'Flags: --json, --cwd <path>\n' +
    'Exit codes: 0 completed, 1 failed/missing, 2 cancelled.',
  cancel:
    'antigravity-plugin cancel — terminate an active background job.\n\n' +
    'Usage: antigravity-plugin cancel [<job-id>] [flags]\n\n' +
    'Flags: --json, --cwd <path>',
};

const [, , raw, ...rest] = process.argv;
const arg0 = (raw || '').toLowerCase();

if (arg0 === '--version' || arg0 === '-v') {
  process.stdout.write(`${readVersion()}\n`);
  process.exit(0);
}

if (!arg0 || arg0 === '-h' || arg0 === '--help' || arg0 === 'help') {
  const sub = (rest[0] || '').toLowerCase();
  if (arg0 === 'help' && sub) {
    if (COMMAND_HELP[sub]) {
      process.stdout.write(`${COMMAND_HELP[sub]}\n`);
      process.exit(0);
    }
    process.stderr.write(`antigravity-plugin: no help for '${rest[0]}'.\n`);
    suggest(sub);
    process.exit(2);
  }
  printHelp();
  process.exit(0);
}

if (!KNOWN.includes(arg0)) {
  process.stderr.write(`antigravity-plugin: unknown command '${raw}'.\n`);
  suggest(arg0);
  process.exit(2);
}

if (rest.includes('--help') || rest.includes('-h')) {
  process.stdout.write(`${COMMAND_HELP[arg0]}\n`);
  process.exit(0);
}

// Friendly preflight: AGY_BIN set but missing → install URL + exit 127.
if (AGY_REQUIRED.has(arg0) && process.env.AGY_BIN && !existsSync(process.env.AGY_BIN)) {
  process.stderr.write(
    `antigravity-plugin: \`agy\` not found at AGY_BIN=${process.env.AGY_BIN}.\n` +
    `Install Google Antigravity CLI from ${INSTALL_URL} or unset AGY_BIN.\n`,
  );
  process.exit(127);
}

const modPath = resolve(SCRIPT_ROOT, `${arg0}.mjs`);
if (!existsSync(modPath)) {
  process.stderr.write(`antigravity-plugin: command module not found at ${modPath}.\n`);
  process.exit(2);
}

let cmd;
try {
  cmd = await import(pathToFileURL(modPath).href);
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(`antigravity-plugin: command '${arg0}' is not implemented yet.\n`);
    process.exit(2);
  }
  process.stderr.write(`antigravity-plugin: ${err?.message ?? err}\n`);
  process.exit(1);
}

const run = cmd.run ?? cmd.default;
if (typeof run !== 'function') {
  process.stderr.write(`antigravity-plugin: command '${arg0}' has no exported run().\n`);
  process.exit(2);
}

try {
  const code = await run(rest, { host: 'standalone', cwd: process.cwd() });
  process.exit(typeof code === 'number' ? code : 0);
} catch (err) {
  process.stderr.write(`antigravity-plugin: ${err?.message ?? err}\n`);
  process.exit(1);
}

function readVersion() {
  try {
    const raw = readFileSync(resolve(ROOT, 'plugin.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function suggest(input) {
  const guess = closest(input, KNOWN);
  if (guess) process.stderr.write(`Did you mean '${guess}'?\n`);
  else printHelp(process.stderr);
}

/** Closest match by Levenshtein, with a length-scaled threshold. */
function closest(input, choices) {
  if (!input) return null;
  let best = null;
  let bestScore = Infinity;
  for (const c of choices) {
    const d = levenshtein(input, c);
    if (d < bestScore) { bestScore = d; best = c; }
  }
  const threshold = Math.min(3, Math.max(1, Math.floor(input.length / 2)));
  return bestScore <= threshold ? best : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function printHelp(stream = process.stdout) {
  stream.write([
    `antigravity-plugin v${readVersion()} — delegate to Google Antigravity (agy)`,
    '',
    'Usage:',
    '  antigravity-plugin <command> [args]',
    '  antigravity-plugin help <command>      detailed help for a command',
    '  antigravity-plugin --version           print version and exit',
    '',
    'Commands:',
    '  setup      One-time interactive OAuth wizard',
    '  review     Review uncommitted changes (--base <ref> for a branch diff)',
    '  adversarial-review  Strict structured (JSON) review of the diff',
    '  rescue     Hand a task off to agy (investigate, fix, refactor, ...)',
    '  task       Free-form prompt with state tracking',
    '  image      Generate an image with agy (Imagen)',
    '  status     List active/recent delegation jobs',
    '  result     Fetch the result of a finished job',
    '  cancel     Cancel a running job',
    '',
    'Common flags: --background, --wait, --continue, --conversation <id>, --json',
    'Env: AGY_BIN, ANTIGRAVITY_SCRIPT_ROOT (testing only)',
    '',
    `Install agy: ${INSTALL_URL}`,
    'Docs:        https://github.com/sakibsadmanshajib/antigravity-plugin',
    '',
  ].join('\n'));
}
