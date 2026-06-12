/**
 * Tests for scripts/lib/git.mjs — exercises the non-trivial branches
 * (parsing porcelain output, branch comparison, untracked reads, scope
 * dispatch) against a temporary real git repo. The repo is tiny and
 * the operations are all `git` builtins, so the test suite stays well
 * under the 30-second budget.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Force a real /tmp; the sandbox TMPDIR points inside a git repo, which
// confounds tests that need an absolutely-not-a-git-repo location.
const TMPROOT = '/tmp';

import {
  ensureGitRepository,
  getCurrentBranch,
  getHeadSha,
  getWorkingTreeFiles,
  getStagedDiff,
  getUnstagedDiff,
  getWorkingTreeDiff,
  readUntrackedFiles,
  collectWorkingTreeContext,
  buildWorkingTreeSummary,
  buildBranchComparison,
  collectReviewContext,
} from '../../plugins/antigravity/scripts/lib/git.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'ignore', env: GIT_ENV });
}

let repo;

before(() => {
  repo = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-git-'));
  sh('git init -q -b main', repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  sh('git add a.txt', repo);
  sh('git commit -q -m initial', repo);
});

after(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
});

describe('git.ensureGitRepository / getCurrentBranch / getHeadSha', () => {
  it('returns repo root and branch metadata for a real repo', () => {
    const root = ensureGitRepository(repo);
    assert.equal(fs.realpathSync(root), fs.realpathSync(repo));

    const branch = getCurrentBranch(repo);
    assert.equal(branch, 'main');

    const sha = getHeadSha(repo);
    assert.match(sha, /^[0-9a-f]{7,}$/);
  });

  it('getCurrentBranch returns null in detached HEAD state', () => {
    const sha = getHeadSha(repo);
    sh(`git checkout -q --detach ${sha}`, repo);
    try {
      assert.equal(getCurrentBranch(repo), null);
    } finally {
      sh('git checkout -q main', repo);
    }
  });

  it('getCurrentBranch returns null for a non-repo cwd', () => {
    const tmp = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-nogit-'));
    try {
      assert.equal(getCurrentBranch(tmp), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('git.getWorkingTreeFiles / diffs', () => {
  it('classifies staged, unstaged, untracked, and renamed entries', () => {
    // Modify a.txt (unstaged), add b.txt staged, create c.txt untracked.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'second\n');
    sh('git add b.txt', repo);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'untracked\n');

    const out = getWorkingTreeFiles(repo);
    assert.ok(out.unstaged.includes('a.txt'), 'a.txt unstaged');
    assert.ok(out.staged.includes('b.txt'), 'b.txt staged');
    assert.ok(out.untracked.includes('c.txt'), 'c.txt untracked');

    assert.ok(getStagedDiff(repo).includes('b.txt'));
    assert.ok(getUnstagedDiff(repo).includes('a.txt'));
    assert.ok(getWorkingTreeDiff(repo).length > 0);
  });

  it('parses a renamed entry (R index status)', () => {
    // Reset to clean state, then commit b.txt and rename it.
    sh('git checkout -q -- a.txt', repo);
    fs.rmSync(path.join(repo, 'c.txt'));
    sh('git commit -q -m add-b', repo);

    sh('git mv b.txt b-renamed.txt', repo);
    const out = getWorkingTreeFiles(repo);
    // git status --porcelain renders renames as "old -> new"; the parser
    // records the full token as a staged entry.
    assert.ok(
      out.staged.some((f) => f.includes('b-renamed.txt')),
      `expected b-renamed.txt in staged, got ${JSON.stringify(out.staged)}`
    );

    // Cleanup: commit the rename so subsequent tests start clean.
    sh('git commit -q -m rename', repo);
  });
});

describe('git.readUntrackedFiles', () => {
  it('reads small text files and skips binary files', () => {
    const root = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-untracked-'));
    try {
      sh('git init -q', root);
      fs.writeFileSync(path.join(root, 'plain.txt'), 'plain text body\n');
      // Binary: NULL byte in first 8 KB
      const bin = Buffer.from([0x48, 0x69, 0x00, 0x21]);
      fs.writeFileSync(path.join(root, 'bin.dat'), bin);

      const results = readUntrackedFiles(root, ['plain.txt', 'bin.dat', 'missing.txt']);
      const byPath = Object.fromEntries(results.map((r) => [r.path, r]));
      assert.equal(byPath['plain.txt'].content.trim(), 'plain text body');
      assert.ok(byPath['bin.dat'].skipped, 'binary file should be skipped');
      assert.ok(
        byPath['missing.txt'].skipped || byPath['missing.txt'].content === undefined,
        'missing file should be skipped'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops reading once the byte budget is exhausted', () => {
    const root = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-untracked2-'));
    try {
      fs.writeFileSync(path.join(root, 'big1.txt'), 'A'.repeat(100));
      fs.writeFileSync(path.join(root, 'big2.txt'), 'B'.repeat(100));

      const results = readUntrackedFiles(root, ['big1.txt', 'big2.txt'], { maxBytes: 100 });
      // First file fits; second triggers budget skip.
      const skipped = results.filter((r) => r.skipped);
      assert.ok(skipped.length >= 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips files outside the cwd via realpath check', () => {
    const real = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-real-'));
    try {
      fs.writeFileSync(path.join(real, 'evil.txt'), 'outside');
      const results = readUntrackedFiles(real, ['evil.txt'], {
        realpathSync: (p) => {
          // Force the path to "resolve" outside cwd.
          if (p.endsWith('evil.txt')) return '/nowhere/evil.txt';
          return p;
        },
      });
      assert.ok(results[0].skipped, 'file claimed outside cwd should be skipped');
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('git.collectWorkingTreeContext / buildWorkingTreeSummary', () => {
  it('assembles a context envelope with summary string', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'newer\n');
    const ctx = collectWorkingTreeContext(repo);
    assert.equal(typeof ctx.summary, 'string');
    assert.ok(ctx.summary.includes('Branch:'));
    assert.equal(ctx.branch, 'main');

    // Pure-fn summary (detached headSha branch).
    const s = buildWorkingTreeSummary(null, 'deadbeef', ['x.js', 'y.js'], ['z.js']);
    assert.match(s, /detached HEAD/);
    assert.match(s, /Untracked files: 1/);
    assert.match(s, /Changed files: 2/);

    const empty = buildWorkingTreeSummary('main', 'abcdef0', [], []);
    assert.match(empty, /Branch: main/);
    assert.ok(!empty.includes('Untracked files'));
  });
});

describe('git.buildBranchComparison', () => {
  it('builds diff/commits/fileList for branch vs base', () => {
    // Snapshot current HEAD as base, then make a branch commit on top.
    sh('git checkout -q -- a.txt', repo);

    sh('git checkout -q -b feature', repo);
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature\n');
    sh('git add feat.txt', repo);
    sh('git commit -q -m feat', repo);

    const cmp = buildBranchComparison(repo, 'main');
    assert.ok(cmp.fileList.includes('feat.txt'));
    assert.ok(cmp.diff.includes('feat.txt'));
    assert.match(cmp.summary, /Changed files: 1/);
    assert.match(cmp.summary, /Comparing HEAD to main/);

    sh('git checkout -q main', repo);
  });
});

describe('git.collectReviewContext', () => {
  it('rejects invalid scopes', () => {
    assert.throws(() => collectReviewContext(repo, { scope: 'nope' }), /Invalid scope/);
  });

  it('uses branch scope when explicit base is given', () => {
    sh('git checkout -q feature', repo);
    try {
      const { scope, context } = collectReviewContext(repo, { scope: 'branch', base: 'main' });
      assert.equal(scope, 'branch');
      assert.ok(context.fileList.length >= 1);
    } finally {
      sh('git checkout -q main', repo);
    }
  });

  it('auto scope falls back to branch comparison when working tree is clean', () => {
    sh('git checkout -q -- a.txt', repo);
    // Clean working tree on feature branch against main.
    sh('git checkout -q feature', repo);
    try {
      const { scope } = collectReviewContext(repo, { scope: 'auto' });
      assert.equal(scope, 'branch');
    } finally {
      sh('git checkout -q main', repo);
    }
  });

  it('auto scope returns working-tree when there are changes', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    try {
      const { scope, context } = collectReviewContext(repo, { scope: 'auto' });
      assert.equal(scope, 'working-tree');
      assert.ok(context.summary.length > 0);
    } finally {
      sh('git checkout -q -- a.txt', repo);
    }
  });

  it('defaults to working-tree when no auto and no branch base', () => {
    const { scope } = collectReviewContext(repo, { scope: 'working-tree' });
    assert.equal(scope, 'working-tree');
  });
});
