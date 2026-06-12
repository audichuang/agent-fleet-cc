/**
 * agent-runtime — single chokepoint for spawning the Antigravity CLI (`agy`).
 *
 * Why a chokepoint?
 *  - Centralizes binary resolution and version probing.
 *  - Lets tests inject a fake binary or mock spawn function.
 *  - Keeps every caller honest about non-streaming output (final response
 *    only) so we never accidentally write code that expects ACP semantics.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';

/** Default binary name. Override via env `AGY_BIN`. */
export const DEFAULT_AGY_BIN = 'agy';

/** agy's own print-mode wait default is 5m; we forward it explicitly. */
export const DEFAULT_PRINT_TIMEOUT_MS = 300000;

/**
 * Resolve the print-mode timeouts:
 *  - `printMs`: forwarded to agy as `--print-timeout` (env `AGY_PRINT_TIMEOUT_MS`).
 *  - `hardMs`: a Node-side SIGTERM backstop in case agy ignores its own timeout
 *    (env `AGY_JOB_TIMEOUT_MS`; defaults to printMs + 60s grace).
 */
export function resolveAgyTimeouts(env = process.env) {
  const printOverride = Number(env.AGY_PRINT_TIMEOUT_MS);
  const printMs = Number.isFinite(printOverride) && printOverride > 0 ? printOverride : DEFAULT_PRINT_TIMEOUT_MS;
  const hardOverride = Number(env.AGY_JOB_TIMEOUT_MS);
  const hardMs = Number.isFinite(hardOverride) && hardOverride > 0 ? hardOverride : printMs + 60000;
  return { printMs, hardMs };
}

/** Format milliseconds as a Go duration string (agy's `--print-timeout` unit). */
function toGoDuration(ms) {
  return `${Math.max(1, Math.ceil(Number(ms) / 1000))}s`;
}

/** Sentinel lines surfaced by `agy --print` when the user needs to (re-)auth. */
const AUTH_LINE_PATTERNS = [
  /^Authentication required\.?\s*Please visit the URL to log in/i,
  /^Waiting for authentication/i,
];
const AUTH_URL_PATTERN = /(https?:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+)/;

/**
 * Resolve the `agy` binary path.
 *
 * Order: `$AGY_BIN` → first `agy` on `PATH` → `~/.local/bin/agy`.
 */
export function resolveAgyBin(env = process.env) {
  if (env.AGY_BIN && existsSync(env.AGY_BIN)) return env.AGY_BIN;

  const PATH = env.PATH || env.Path || '';
  for (const dir of PATH.split(':').filter(Boolean)) {
    const candidate = join(dir, DEFAULT_AGY_BIN);
    if (existsSync(candidate)) return candidate;
  }

  const home = env.HOME;
  if (home) {
    const candidate = join(home, '.local', 'bin', DEFAULT_AGY_BIN);
    if (existsSync(candidate)) return candidate;
  }

  return DEFAULT_AGY_BIN;
}

/**
 * Probe `agy --version`. Resolves to `{ ok: true, version }` or
 * `{ ok: false, reason }`.
 */
export async function probeAgy({ bin = resolveAgyBin(), timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: e.code === 'ENOENT' ? 'not-installed' : e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, reason: `exit ${code}` });
      resolve({ ok: true, version: stdout.trim().split(/\s+/)[0] || 'unknown' });
    });
  });
}

/**
 * Run `agy --print <prompt>` (or a continuation variant) and capture stdout.
 *
 * `mode`:
 *   - `print` (default) — `agy --print <prompt>`
 *   - `continue` — `agy --continue --print <prompt>`
 *   - `conversation` — `agy --conversation <id> --print <prompt>`
 *
 * Returns `{ status, stdout, stderr, exitCode, oauthUrl? }`. `status` is one
 * of `completed`, `failed`, `auth_required`, `cancelled`, `timeout`.
 */
export async function runAgyPrint({
  prompt,
  mode = 'print',
  conversationId,
  cwd = process.cwd(),
  addDirs = [],
  timeoutMs = 0,
  printTimeoutMs = 0,
  model,
  sandbox = false,
  bin = resolveAgyBin(),
  env = process.env,
  onStdout,
  onStderr,
  signal,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.length) {
    throw new TypeError('runAgyPrint: prompt must be a non-empty string');
  }
  const args = [];
  if (mode === 'continue') args.push('--continue');
  if (mode === 'conversation') {
    if (!conversationId) throw new TypeError('runAgyPrint: conversationId required for mode=conversation');
    args.push('--conversation', conversationId);
  }
  if (model) args.push('--model', String(model));
  if (sandbox) args.push('--sandbox');
  if (printTimeoutMs > 0) args.push('--print-timeout', toGoDuration(printTimeoutMs));
  for (const dir of addDirs) args.push('--add-dir', dir);
  args.push('--print', prompt);

  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let oauthUrl;
  let status;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!oauthUrl) {
      const m = chunk.match(AUTH_URL_PATTERN);
      if (m) {
        oauthUrl = m[1];
        status ??= 'auth_required';
      } else if (AUTH_LINE_PATTERNS.some((p) => p.test(chunk))) {
        status ??= 'auth_required';
      }
    }
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    onStderr?.(chunk);
  });

  const timer = timeoutMs > 0
    ? setTimeout(() => {
        status = 'timeout';
        child.kill('SIGTERM');
      }, timeoutMs)
    : null;

  if (signal) {
    if (signal.aborted) child.kill('SIGTERM');
    else signal.addEventListener('abort', () => {
      status = 'cancelled';
      child.kill('SIGTERM');
    }, { once: true });
  }

  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => {
      stderr += `\nspawn error: ${e.message}`;
      resolve(typeof e.errno === 'number' ? e.errno : 1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });

  if (timer) clearTimeout(timer);

  if (!status) status = exitCode === 0 ? 'completed' : 'failed';

  return { status, stdout, stderr, exitCode, oauthUrl };
}

/**
 * Tiny helper for callers that want to fire-and-forget into the background.
 * Returns the child handle without awaiting, so the caller is responsible
 * for capturing exit + stdout in a separate file (see job-control.mjs).
 */
export function spawnAgyDetached({
  prompt,
  mode = 'print',
  conversationId,
  cwd = process.cwd(),
  addDirs = [],
  bin = resolveAgyBin(),
  env = process.env,
  stdout = 'pipe',
  stderr = 'pipe',
} = {}) {
  const args = [];
  if (mode === 'continue') args.push('--continue');
  if (mode === 'conversation') {
    if (!conversationId) throw new TypeError('spawnAgyDetached: conversationId required for mode=conversation');
    args.push('--conversation', conversationId);
  }
  for (const dir of addDirs) args.push('--add-dir', dir);
  args.push('--print', prompt);

  return spawn(bin, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', stdout, stderr],
  });
}
