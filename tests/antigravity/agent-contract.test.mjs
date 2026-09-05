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
    assert.match(agent, /Do not call `setup`, `review`, `adversarial-review`, `task`, `status`, `result`, `cancel`, `wait`, or `logs`/i);
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
 * 0.7.1 — the dispatch facts a model needs before it chooses foreground.
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

    // NOT a shared /five minutes/ loop over both files. SKILL.md says it twice — in the
    // heading that IS the rule, and in the explanation below — so a whole-file match
    // stayed green with the heading switched back to ten. Anchor each file on its own
    // rule-bearing line. (Fourth time this exact hole appeared in this file: a
    // document-wide match on a token the document repeats is the default failure mode
    // here, not an edge case.)
    assert.match(
      skill,
      /^##[^\n]*foreground dies at about five minutes/m,
      'SKILL.md: the Timeouts heading is the rule — it must carry the number itself',
    );
    assert.doesNotMatch(
      skill,
      /^##[^\n]*foreground dies at about ten minutes/m,
      'SKILL.md: ten is the host ceiling, never what stops an agy turn',
    );
    assert.match(agent, /five minutes/i, 'agy-rescue.md must name the bound that actually binds');
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
      // Scope to the sentence, not the file. Two earlier versions of this guard
      // asserted `/antigravity:status/` and `` /`result`/ `` against the whole
      // document and both were vacuous: the background-dispatch bullet already
      // mentions the status command, and the "Do not call" list already contains
      // `result`. Every token worth asserting here appears somewhere else in these
      // files, so a document-wide match proves nothing.
      // Chunk by bullet or paragraph, because the two files wrap differently: the
      // agent keeps each rule on one long line, SKILL.md hard-wraps mid-sentence, so
      // a per-LINE search finds the reconcile in one and misses its other half in the
      // other. Splitting before `- ` and on blank lines gives the same unit in both.
      const line = body
        .split(/\n(?=- )|\n\n/)
        .find((chunk) => /reconcileDeadPids|dead-pid reconcile/.test(chunk));
      assert.ok(line, `${rel} must say what finalizes a cut-off run's record`);
      assert.match(
        line,
        /antigravity:status|\$antigravity status/,
        `${rel}: the reconcile sentence must name where the run resolves`,
      );
      // Token presence is not the contract. Text saying the OPPOSITE — "a killed call
      // is lost and leaves no record, reconcile with $antigravity status or `result`" —
      // contains every token the old version of this guard looked for and passed it.
      // Assert the claim, and assert that its negation is absent.
      assert.match(
        body,
        /not the same as a lost turn|is not a lost turn/i,
        `${rel}: the point is that the record SURVIVES — say it, don't imply it`,
      );
      assert.doesNotMatch(
        body,
        /leaves no record|is lost and/i,
        `${rel}: a cut-off foreground run is recoverable; do not tell the model otherwise`,
      );
      // The read set has to be complete. status/logs/wait/result all reconcile, and a
      // short list walks the reader past a place that would have shown them the record.
      // Backticks REQUIRED. With them optional this matched bare prose — the same
      // chunk says "do not report a failed or empty result", so dropping `result`
      // from the list left the guard green. Fifth instance of this shape in this file:
      // a pattern loose enough to hit incidental words is the same bug as a
      // document-wide match, just scoped smaller.
      for (const verb of ['status', 'logs', 'wait', 'result']) {
        assert.match(
          line,
          new RegExp('`' + verb + '`'),
          `${rel}: ${verb} reconciles too — an incomplete list hides the finalized record`,
        );
      }
      // cancel reconciles as well, but it MUTATES. Offering it as somewhere to look is
      // worse than omitting it: a model told "any of these five" may cancel a job it was
      // only trying to inspect. If it is named at all, it must be marked.
      if (/`cancel`/.test(line)) {
        assert.match(
          line,
          /`cancel`[\s\S]{0,200}(state-changing|changes job state|never (?:reach for it|run it) just to look)/i,
          `${rel}: cancel is not a read command — say so wherever it is listed`,
        );
      }
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
describe('every surface that mentions --sandbox explains what it does not do', () => {
  // The first version of this guard tried to BAN phrasings ("--sandbox ... cannot
  // mutate"). That was wrong in both directions, and an independent review showed it
  // empirically: it leaked whenever the claim came first ("Read-only: agy runs under
  // `--sandbox` to inspect code"), across a line break, or across a sentence boundary —
  // and it REJECTED the correct clarification ("runs under `--sandbox`, but this does
  // not block writes"), because "does not block writ..." matched the ban pattern.
  //
  // The set of wrong phrasings is unbounded; the right framing is not. So require the
  // framing wherever the flag is mentioned at all. plugins/antigravity/AGENTS.md is the
  // source of this rule: --sandbox is an nsjail TERMINAL container. It blocks shell
  // commands, not `write_file`, and the model can opt out of it per call.
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
    it(`${rel} does not leave --sandbox reading as a write guard`, () => {
      const body = read(rel);
      if (!/--sandbox/.test(body)) return; // nothing to qualify
      assert.match(
        body,
        /by instruction|blocks shell commands, not|not by enforcement|does not block writes/i,
        `${rel} mentions --sandbox, so it must also say the posture is by instruction, ` +
          'not enforcement — the flag blocks shell commands, not write_file',
      );
    });
  }
});


/*
 * NOT guarded here: whether SKILL.md carries a model catalog. That de-rot lives on
 * `antigravity/catalog-rot-and-partial-output`, which does it better than this branch
 * did — it found that agy 1.1.10 fixed `--model` being silently ignored in headless
 * `-p`, which means the 1.1.5 "Pro tier stalls in --print" observation was never
 * attributable to the model at all. A guard here would either duplicate that branch or
 * pin prose this branch deliberately leaves alone.
 */
