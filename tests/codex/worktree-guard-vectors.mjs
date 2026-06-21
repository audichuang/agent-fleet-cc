// SSOT 正反例 —— 維度 B 的 JS 單元測試吃它;維度 A 的 SKILL.md 在文件中引用同樣的案例描述。
export const TRIPLET_VECTORS = [
  { name: "all three present", source: { "expected-worktree": "/wt", "expected-branch": "feat", "expected-base": "abc" },
    expect: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "abc" } },
  { name: "none present", source: {}, expect: null },
  { name: "partial (only path) throws", source: { "expected-worktree": "/wt" }, throws: true },
  { name: "partial (path+branch) throws", source: { "expected-worktree": "/wt", "expected-branch": "feat" }, throws: true },
  { name: "request-shaped keys", source: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "abc" },
    expect: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "abc" } }
];

// align 案例:fake git 回應 -> 期望 pass/throw。每筆 git 是 { "<args join ' '>": {status, stdout} }。
export const ALIGN_VECTORS = [
  { name: "exact match passes",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/wt" },
           "branch --show-current": { status: 0, stdout: "feat" },
           "merge-base --is-ancestor base1 HEAD": { status: 0, stdout: "" } },
    pass: true },
  { name: "wrong tree throws",
    cwd: "/other", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/other" } }, pass: false },
  { name: "wrong branch throws",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/wt" },
           "branch --show-current": { status: 0, stdout: "main" } }, pass: false },
  { name: "baseline lost (not ancestor) throws",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/wt" },
           "branch --show-current": { status: 0, stdout: "feat" },
           "merge-base --is-ancestor base1 HEAD": { status: 1, stdout: "" } }, pass: false },
  { name: "not a git repo throws (no fallback)",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 128, stdout: "" } }, pass: false }
];
