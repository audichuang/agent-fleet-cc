/**
 * /antigravity:setup — interactive OAuth wizard.
 *
 * Spawns `agy --print 'noop'` in the foreground so the user sees the OAuth
 * URL and can paste the resulting code. Idempotent: a no-op when the token
 * cache is already valid.
 */
import { spawn } from 'node:child_process';
import { resolveAgyBin, probeAgy } from '../lib/agent-runtime.mjs';
import { runAsMain } from '../lib/cli-entry.mjs';

export async function run(argv = [], ctx = {}) {
  const bin = resolveAgyBin();
  const probe = await probeAgy({ bin });
  if (!probe.ok) {
    process.stderr.write(
      `antigravity:setup — \`agy\` is not on PATH (${probe.reason}).\n` +
      `Install it from https://antigravity.google/download then re-run.\n`,
    );
    return 2;
  }

  process.stdout.write(`antigravity:setup — using ${bin} v${probe.version}\n`);
  process.stdout.write(`Triggering an authenticated probe. Complete the OAuth flow in your browser if prompted.\n\n`);

  const child = spawn(bin, ['--print', 'Reply with the word OK and nothing else.'], {
    stdio: 'inherit',
    cwd: ctx.cwd ?? process.cwd(),
    env: process.env,
  });

  return await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (e) => {
      process.stderr.write(`antigravity:setup — spawn error: ${e.message}\n`);
      resolve(1);
    });
  });
}

export default run;

runAsMain(import.meta.url, run, "setup");
