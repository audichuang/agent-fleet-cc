/**
 * Doc-contract tests for the agy-rescue subagent (agents/agy-rescue.md) and its
 * router (commands/rescue.md). Mirrors codex's tests/codex/commands.test.mjs
 * approach: the agent, the router, and the runtime are three copywriters of one
 * contract — these assertions fail the build when any of them drifts.
 *
 * Layer 2 goes beyond wording: every `--flag` either doc mentions must exist in
 * rescue.mjs's parseCommandInput option tables, so a doc can never advertise a
 * flag the runtime silently drops.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(__dirname, '../../plugins/antigravity');
const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');

const agent = read('agents/agy-rescue.md');
const router = read('commands/rescue.md');
const runtime = read('scripts/commands/rescue.mjs');

describe('agy-rescue agent contract', () => {
  it('has the expected frontmatter (thin Bash-only forwarder on a cheap model)', () => {
    assert.match(agent, /^---\nname: agy-rescue\n/);
    assert.match(agent, /\nmodel: sonnet\n/);
    assert.match(agent, /\ntools: Bash\n/);
    assert.match(agent, /\ndescription: Proactively use when/);
  });

  it('is a thin forwarder: one Bash call to rescue.mjs, output verbatim, no side work', () => {
    assert.match(agent, /thin forwarding wrapper/i);
    assert.match(agent, /Use exactly one `Bash` call/i);
    // First real smoke (agy 1.1.5, 2026-07-23): a clean-exit empty --print
    // response is a real flake; one identical retry is allowed — but only for
    // side-effect-free calls (codex review finding: --apply/--resume/--continue/
    // --conversation runs may have edited files or advanced a conversation).
    assert.match(agent, /none of `--apply`, `--background`, `--resume`, `--continue`, or `--conversation`[^.]*exits 0 but prints nothing[^.]*retry the identical command once/i);
    assert.match(agent, /Never retry a run that carried any of those flags/i);
    assert.match(agent, /Never retry a non-zero exit, and never retry more than once/i);
    assert.match(agent, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/commands\/rescue\.mjs/);
    assert.match(agent, /Never hardcode a cache\/versioned path/i);
    assert.match(agent, /--prompt-file <path>/);
    assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
    assert.match(agent, /Do not call `setup`, `review`, `adversarial-review`, `task`, `image`, `status`, `result`, `cancel`, `wait`, or `logs`/i);
    assert.match(agent, /Do not add commentary before or after/i);
  });

  it('encodes agy write semantics: --apply is opt-in, skip-permissions gated on it', () => {
    assert.match(agent, /do NOT pass `--apply`/);
    assert.match(agent, /Add `--apply` only when the request explicitly asks agy to edit files/i);
    assert.match(agent, /not a hard read-only guard/i);
    assert.match(agent, /`--dangerously-skip-permissions`[^.]*only together with `--apply`/i);
  });

  it('encodes agy execution physics: no streaming, long foreground timeout, background for long tasks', () => {
    assert.match(agent, /agy cannot stream/i);
    assert.match(agent, /timeout to 600000/);
    assert.match(agent, /prefer background execution/i);
    assert.match(agent, /\/antigravity:status <id>/);
    // Cross-host honesty (codex review finding): agent-initiated backgrounding
    // is Claude-Code-only; the verb's own default stays foreground everywhere.
    // Was /Claude Code dispatch policy/ — it attributed the background rule to the
    // HOST's ten-minute Bash ceiling. agy's own print timeout is half that and fires
    // first, so the rule is an ENGINE property; the old phrasing sent a model to the
    // wrong bound. Pin the correct attribution instead.
    assert.match(agent, /agy's own print-mode timeout/i);
    assert.match(agent, /the engine always times out first/i);
    assert.match(agent, /foreground-by-default on every host/i);
  });

  it('surfaces failures: stdout verbatim plus stderr on non-zero exit, never a substitute answer', () => {
    assert.match(agent, /Return the stdout of the `rescue\.mjs` command exactly as-is/i);
    // First real smoke: the forwarder translated agy's 中文 answer to English.
    assert.match(agent, /even if its language differs from the conversation language/i);
    assert.match(agent, /Do not translate, paraphrase, reformat, or summarize/i);
    assert.match(agent, /On a non-zero exit, return the stderr text verbatim as well/i);
    assert.match(agent, /never invent a substitute answer/i);
    assert.match(agent, /run `\/antigravity:setup`/);
    assert.match(agent, /One narrow exception to the no-commentary rule/i);
    assert.match(agent, /Only if there is genuinely no output at all/i);
    // The recursion guard and the friendly exit-127 preflight live only in
    // bin/antigravity.mjs; the forwarder calls rescue.mjs directly and must
    // not claim guards that path does not have (codex review finding).
    assert.doesNotMatch(agent, /recursion guard|exit 127/i);
  });

  it('handles resume routing without asking (asking is the router\'s job)', () => {
    assert.match(agent, /`--resume`, `--continue`, or `--fresh`, pass it through/i);
    assert.match(agent, /"continue", "keep going", "resume", "apply the top fix", or "dig deeper"/);
    assert.match(agent, /Leave `--model` unset by default/i);
    assert.match(agent, /pass the value through verbatim/i);
  });
});

describe('rescue.md router contract', () => {
  it('runs inline and routes to the subagent via the Agent tool (no fork, no Skill recursion)', () => {
    // Regression guard (codex #234 analogue): `context: fork` would drop the
    // Agent tool from scope, and Skill(antigravity:rescue) re-enters this file.
    assert.doesNotMatch(router, /^context:\s*fork\b/m);
    assert.match(router, /allowed-tools:\s*AskUserQuestion,\s*Agent/);
    assert.match(router, /subagent_type: "antigravity:agy-rescue"/);
    assert.match(router, /do not call `Skill\(antigravity:agy-rescue\)`/i);
    assert.match(router, /`Skill\(antigravity:rescue\)`/);
    assert.match(router, /The command runs inline so the `Agent` tool stays in scope/i);
  });

  it('keeps Claude-side execution flags out of the forwarded task', () => {
    assert.match(router, /run the `antigravity:agy-rescue` subagent in the background/i);
    assert.match(router, /default to foreground/i);
    assert.match(router, /Do not forward them to `rescue`/i);
    assert.match(router, /agy cannot stream/i);
  });

  it('owns the resume question and forwards the choice as --resume/--fresh', () => {
    assert.match(router, /AskUserQuestion/);
    assert.match(router, /Continue most recent Antigravity thread/);
    assert.match(router, /Start a new Antigravity thread/);
    assert.match(router, /If the user chooses continue, add `--resume`/i);
    assert.match(router, /If the user chooses a new thread, add `--fresh`/i);
    assert.match(router, /Leave `--resume`, `--continue`, and `--fresh` in the forwarded request/i);
  });

  it('preserves write-mode and runtime flags with the same semantics as the runtime', () => {
    assert.match(router, /`--apply` and `--dangerously-skip-permissions` are write-mode flags/i);
    assert.match(router, /Antigravity does not edit your repo/i);
    assert.match(router, /only takes effect together with `--apply`/i);
    assert.match(router, /Return the Antigravity companion output verbatim/i);
    assert.match(router, /run `\/antigravity:setup`/);
  });
});

describe('doc flags exist in the runtime parser', () => {
  const optionTable = (src, key) => {
    const m = src.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
    assert.ok(m, `rescue.mjs should declare ${key}`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const known = new Set([
    ...optionTable(runtime, 'valueOptions'),
    ...optionTable(runtime, 'booleanOptions'),
  ]);

  for (const [label, doc] of [['agent', agent], ['router', router]]) {
    it(`every --flag the ${label} doc mentions is a real rescue.mjs option`, () => {
      const flags = new Set([...doc.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
      for (const flag of flags) {
        assert.ok(known.has(flag), `${label} doc mentions --${flag}, unknown to rescue.mjs`);
      }
    });
  }
});

/**
 * 0.6.2 — the dispatch facts a model needs before it chooses foreground.
 *
 * The agent used to say "past ten minutes", copied from the Bash tool's ceiling.
 * That is the wrong bound for agy by a factor of two: `--print-timeout` defaults
 * to 5m (DEFAULT_PRINT_TIMEOUT_MS in scripts/lib/adapter.mjs) and the plugin
 * passes it, with the Node backstop deliberately one minute later so the engine
 * always times out first. A model judging by ten would leave a seven-minute task
 * in the foreground to be killed at five.
 *
 * Pinned against the constant, not just the prose: if the default moves, this
 * goes red and the doc has to move with it.
 */
describe('foreground timeout guidance', () => {
  it('names five minutes, and the number matches the constant it describes', () => {
    const agent = read('agents/agy-rescue.md');
    const skill = read('SKILL.md');
    const adapter = read('scripts/lib/adapter.mjs');

    const declared = /DEFAULT_PRINT_TIMEOUT_MS\s*=\s*(\d+)/.exec(adapter);
    assert.ok(declared, 'adapter must declare the print timeout default');
    assert.equal(
      Number(declared[1]) / 60000,
      5,
      'the docs below say five minutes; change them in the same commit as this constant',
    );

    for (const [name, body] of [['agy-rescue.md', agent], ['SKILL.md', skill]]) {
      assert.match(body, /five minutes/i, `${name} must name the bound that actually binds`);
    }
    // Anchor on the DISPATCH sentence, not on any occurrence of "five minutes" —
    // the file explains the number a paragraph later, so a bare /five minutes/
    // stays green even when the rule itself has been switched back to ten. Both
    // patterns tolerate markdown emphasis, which is where the first version of
    // this guard leaked: the real text is `running **past about five minutes**`
    // and an un-escaped `running past ten minutes` matched neither wording.
    assert.match(
      agent,
      /keep agy running[\s*]*past about five minutes/i,
      'the dispatch rule itself must carry the number, not just the explanation below it',
    );
    assert.doesNotMatch(
      agent,
      /keep agy running[\s*]*past (about )?ten minutes/i,
      'the Bash ceiling is the looser bound and never what stops an agy turn',
    );
  });

  it('says a killed foreground call still left a record', () => {
    // runForeground creates the job BEFORE starting the worker (job-runtime.mjs),
    // so a cut-off run is recoverable — but it can read `running` until a
    // dead-pid reconcile, which only status/logs/wait trigger. Without this the
    // honest-looking move is to report a failed review, which is wrong.
    for (const rel of ['agents/agy-rescue.md', 'SKILL.md']) {
      const body = read(rel);
      assert.match(body, /reconcile/i, `${rel} must say what finalizes the record`);
      assert.match(
        body,
        /antigravity:status|\$antigravity status/,
        `${rel} must name where a cut-off run resolves`,
      );
    }
  });
});

/**
 * The stop-rule review.md has carried since it was written, and
 * adversarial-review.md never did — even though it is the surface used on code
 * that is about to ship, where auto-applying a finding is worst.
 */
describe('review verbs carry the do-not-auto-fix stop-rule', () => {
  for (const rel of ['commands/review.md', 'commands/adversarial-review.md']) {
    it(`${rel} tells the host to ask before fixing anything`, () => {
      const body = read(rel);
      assert.match(
        body,
        /Do not make any code changes based on the review findings/,
        'presenting findings verbatim is not the same as not acting on them',
      );
      assert.match(body, /ask them which finding to address first/i);
    });
  }
});

/**
 * plugins/antigravity/AGENTS.md: "任何文案都不准把 `--sandbox` 講成 read-only".
 * It is an nsjail *terminal* container — it blocks shell commands, not
 * `write_file`, and the model can opt out per call. A doc that calls it
 * read-only tells the reader the tree is protected when it is not.
 */
describe('no shipped prose describes --sandbox as a write guard', () => {
  const surfaces = [
    'SKILL.md',
    'README.md',
    'commands/review.md',
    'commands/adversarial-review.md',
    'commands/task.md',
    'commands/rescue.md',
    'agents/agy-rescue.md',
  ];
  for (const rel of surfaces) {
    it(`${rel} does not claim --sandbox prevents writes`, () => {
      const body = read(rel);
      // Any sentence putting --sandbox and a can't-write claim together. The
      // README's "Read-only **by instruction**" phrasing is the correct one and
      // does not match, because it attributes the posture to the prompt.
      assert.doesNotMatch(
        body,
        /`--sandbox`[^.\n]{0,80}(cannot mutate|read-only|prevents? writ|blocks? writ)/i,
        'the sandbox blocks shell commands, not write_file — say read-only BY INSTRUCTION',
      );
    });
  }
});

/**
 * The model catalog moved two tiers in the weeks after SKILL.md named one, and
 * nothing went red. Root AGENTS.md forbids enumerating an engine catalog in
 * shipped prose for exactly this reason; the authority is `agy models`.
 *
 * The one allowed mention is the stall hazard, which `agy models` cannot report
 * and which is explicitly dated — so this counts slugs rather than banning them.
 */
describe('SKILL.md does not carry a model catalog', () => {
  it('names at most the one dated hazard slug, and points at the authority', () => {
    const skill = read('SKILL.md');
    const slugs = [...skill.matchAll(/gemini-[\d.]+-[a-z]+(?:-[a-z]+)?/g)].map((m) => m[0]);
    assert.ok(
      slugs.length <= 1,
      `SKILL.md should not list model slugs; found ${slugs.length}: ${slugs.join(', ')}`,
    );
    if (slugs.length === 1) {
      assert.match(
        skill,
        new RegExp(`${slugs[0]}[^)]*\\d{4}-\\d{2}-\\d{2}`),
        'a slug survives only as a dated observation, never as a recommendation',
      );
    }
    assert.match(skill, /`agy models`/, 'the authority has to be named, or removal just loses the answer');
  });
});
