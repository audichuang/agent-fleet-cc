/**
 * cli-entry — shared self-invoke shim for command modules.
 *
 * Each `scripts/commands/<verb>.mjs` exports `run(argv, ctx)` for the bin
 * dispatcher and the test suite, but the slash-command `.md` files invoke the
 * module directly (`node scripts/commands/<verb>.mjs $ARGUMENTS`). Without a
 * self-invoke block the slash command would do nothing. `runAsMain` provides
 * that block in one place so every command behaves identically.
 */

import { pathToFileURL } from "node:url";

/**
 * Invoke `run` when `moduleUrl` is the process entry point.
 *
 * @param {string} moduleUrl - the module's `import.meta.url`.
 * @param {(argv: string[], ctx: { host: string, cwd: string }) => Promise<number|void>} run
 * @param {string} name - command name, used in the error prefix.
 */
export function runAsMain(moduleUrl, run, name) {
  const entry = process.argv[1];
  if (!entry || moduleUrl !== pathToFileURL(entry).href) return;

  Promise.resolve(run(process.argv.slice(2), { host: "claude-code", cwd: process.cwd() }))
    .then((code) => process.exit(typeof code === "number" ? code : 0))
    .catch((err) => {
      process.stderr.write(`antigravity:${name} — ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
