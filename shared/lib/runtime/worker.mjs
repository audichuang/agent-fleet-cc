// shared/lib/runtime/worker.mjs
// 通用 detached worker(藍圖 §5.1):吃 adapter,驅動完整生命週期。
// foreground 路徑 in-process await;background 路徑由 companion 以
// `node worker-cli 入口 <stateDir> <jobId>` detached 執行(Plan B 接線)。
import fs from "node:fs";
import readline from "node:readline";
import { TERMINAL_STATUSES } from "../core/job.mjs";
import { buildEngineEnv } from "../core/env.mjs";
import { appendEvent } from "../core/events.mjs";
import {
  readJob,
  markJobRunning,
  finalizeJob,
  readTerminalLock,
  promptFilePath,
  logFilePath,
  jobDir,
} from "../core/state-store.mjs";
import { spawnEngine, killGroupWithGrace } from "./spawn.mjs";

const STDERR_TAIL_BYTES = 4096;

// cancel 以 SIGTERM 到 worker;貴的是引擎 child(及其孫子)— 轉發成
// process-group kill,否則殭屍引擎在 bypassPermissions 下繼續改檔燒錢。
export function installCancelForwarder({
  proc = process,
  graceMs = 5000,
  forceExitMs = null,
  killImpl,
  exitImpl = (code) => process.exit(code),
  scheduleImpl = setTimeout,
} = {}) {
  let childPid = null;
  let terminated = false;
  const killSequence = (pid) =>
    killGroupWithGrace(pid, { graceMs, scheduleImpl, ...(killImpl ? { killImpl } : {}) });
  const handler = () => {
    terminated = true;
    if (childPid) killSequence(childPid);
    if (forceExitMs !== null) {
      // 孫子可能繼承 stdio pipes 讓 close 永不發生;SIGTERM 我們的人已經
      // finalize 過 job,自我硬退出是安全的。
      scheduleImpl(() => exitImpl(0), forceExitMs)?.unref?.();
    }
  };
  proc.once("SIGTERM", handler);
  return {
    onChild(child) {
      childPid = child.pid;
      if (terminated) killSequence(childPid); // SIGTERM 先於 spawn 到達
    },
    dispose() {
      proc.removeListener("SIGTERM", handler);
    },
  };
}

// 早期失敗的共用 finalize+finalized 邏輯(與主路徑對稱)。
// won=true → worker 寫 finalized event;won=false(lost-CAS)→ 讀真實終態後也寫。
// 這樣 events.ndjson 永遠有一條 finalized,符合 spec §5 不變量(2)。
function earlyFinalize(stateDir, jobId, patch) {
  const dir = jobDir(stateDir, jobId);
  const won = finalizeJob(stateDir, jobId, patch);
  let finalStatus;
  if (won) {
    finalStatus = patch.status;
  } else {
    const lock = readTerminalLock(stateDir, jobId);
    const lockStatus = lock?.status ?? null;
    if (lockStatus !== null) {
      finalStatus = lockStatus;
    } else {
      const jobStatus = readJob(stateDir, jobId)?.status ?? null;
      finalStatus = (jobStatus !== null && TERMINAL_STATUSES.has(jobStatus))
        ? jobStatus
        : "failed";
    }
  }
  appendEvent(dir, "finalized", { status: finalStatus, by: won ? "worker" : "lost-cas" });
  return won;
}

export async function runWorker({ stateDir, jobId, adapter, deps = {} }) {
  const startedAt = Date.now();
  const job = readJob(stateDir, jobId);
  if (!job) return 1;
  let prompt;
  try {
    prompt = fs.readFileSync(promptFilePath(stateDir, jobId), "utf8");
  } catch {
    earlyFinalize(stateDir, jobId, { status: "failed", error: "prompt file missing" });
    return 1;
  }

  // CAS 守住 queued→running:輸給 canceller 就什麼都不准 spawn — exit 0 是
  // 正確結果,不是錯誤。
  const running = markJobRunning(stateDir, jobId, { pid: deps.pid ?? process.pid });
  if (!running) return 0;

  let invocation;
  try {
    invocation = adapter.buildInvocation({ job: running, prompt });
  } catch (error) {
    const errMsg = String(error?.message ?? error);
    earlyFinalize(stateDir, jobId, {
      status: "failed",
      error: errMsg,
      errorKind: "adapter",
    });
    return 1;
  }
  // 消毒是強制縫(spec §5):adapter 的 env 只算「顯式注入」,繼承剝除與
  // 遞迴標記由這裡保證,adapter 不可繞過。
  // adapter に recursionMarker がない場合 buildEngineEnv が throw する — 隣の
  // buildInvocation パスと対称に try/catch + finalize で受ける(spec §5 不変量 1)。
  let env;
  try {
    env = buildEngineEnv({
      baseEnv: deps.baseEnv ?? process.env,
      engineEnv: invocation.env ?? {},
      recursionMarker: adapter.recursionMarker,
    });
  } catch (error) {
    const errMsg = String(error?.message ?? error);
    earlyFinalize(stateDir, jobId, {
      status: "failed",
      error: errMsg,
      errorKind: "adapter",
    });
    return 1;
  }

  const dir = jobDir(stateDir, jobId);
  const logStream = fs.createWriteStream(logFilePath(stateDir, jobId), {
    flags: "a",
    mode: 0o600,
  });
  const events = [];
  const outcome = await new Promise((resolve) => {
    const state = {
      exitCode: null,
      signal: null,
      stderrTail: "",
      stdinError: null,
      spawnError: null,
      timedOut: false,
    };
    let child;
    try {
      child = spawnEngine({
        argv: invocation.argv,
        env,
        cwd: running.cwd,
        ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
      });
    } catch (error) {
      state.spawnError = String(error?.message ?? error);
      resolve(state);
      return;
    }
    appendEvent(dir, "spawned", { pid: child.pid });
    deps.onChild?.(child);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve(state);
    };
    let forceTimer = null;
    const timeoutMs = running.timeoutMs ?? 60 * 60 * 1000;
    const timer = setTimeout(() => {
      state.timedOut = true;
      const graceMs = deps.graceMs ?? 5000;
      killGroupWithGrace(child.pid, { graceMs, scheduleImpl: deps.scheduleImpl ?? setTimeout });
      // Force-resolve after kill+grace+buffer even when a grandchild holding stdout
      // prevents the 'close' event from ever firing (spec §5 invariant 1: job 必達終態).
      // This mirrors the forceExitMs escape hatch in installCancelForwarder.
      // We add a small buffer (200ms) on top of graceMs to let legitimate close events land.
      const forceMs = graceMs + (deps.forceResolveExtraMs ?? 200);
      forceTimer = (deps.scheduleImpl ?? setTimeout)(() => finish(), forceMs);
      forceTimer?.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdin.on("error", (error) => {
      state.stdinError = state.stdinError ?? error;
    });
    try {
      child.stdin.write(invocation.stdinPayload ?? "");
      child.stdin.end();
    } catch (error) {
      state.stdinError = state.stdinError ?? error;
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      logStream.write(line + "\n");
      let parsed;
      try {
        parsed = adapter.parseEvent(line);
      } catch {
        parsed = null; // parseEvent 永不 fatal
      }
      if (parsed) {
        // 'type: "engine-event"' は最後に置く。parseEvent が engine 固有の
        // type フィールド(例: {type:"result",...})を返した場合でも、
        // 正規化 type が常に "engine-event" になる(spec §3)。
        // parsed fields are spread first so extractResult can still access
        // e.g. e.kind / e.text directly; raw holds the original line for
        // replay/audit; type: "engine-event" overrides any parsed .type.
        const engineEvent = { ...parsed, raw: line, type: "engine-event" };
        events.push(engineEvent);
        // appendEvent already puts type last (events.mjs), but we pass
        // parsed+raw explicitly to keep the same override guarantee.
        appendEvent(dir, "engine-event", { ...parsed, raw: line });
      }
    });
    child.stderr.on("data", (chunk) => {
      state.stderrTail = (state.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => {
      state.spawnError = state.spawnError ?? String(error?.message ?? error);
      finish();
    });
    child.on("close", (code, signal) => {
      state.exitCode = code;
      state.signal = signal ?? null;
      finish();
    });
  });
  logStream.end();

  let result = { ok: false, resultText: null, sessionId: null, usage: null };
  try {
    result = { ...result, ...adapter.extractResult(events, outcome.exitCode) };
  } catch {}
  const failed =
    Boolean(outcome.spawnError) ||
    Boolean(outcome.stdinError) ||
    outcome.exitCode !== 0 ||
    !result.ok;
  const status = outcome.timedOut ? "timed-out" : failed ? "failed" : "completed";
  let error = null;
  let errorKind = null;
  if (status !== "completed") {
    error = outcome.stdinError
      ? `stdin: ${outcome.stdinError.code ?? outcome.stdinError.message}`
      : (outcome.spawnError || outcome.stderrTail || "engine exited nonzero").slice(-500);
    try {
      errorKind = outcome.timedOut
        ? "timeout"
        : adapter.classifyError(outcome.stderrTail, outcome.exitCode);
    } catch {
      errorKind = "unknown";
    }
  }
  appendEvent(dir, "result", { ok: result.ok, status });
  const won = finalizeJob(stateDir, jobId, {
    status,
    exitCode: outcome.exitCode,
    sessionId: result.sessionId ?? running.sessionId ?? null,
    resultText: result.resultText,
    usage: result.usage ?? null,
    durationMs: Date.now() - startedAt,
    error,
    errorKind,
  });
  // 輸掉 CAS(canceller 先 finalize)時,finalized event 必須記真實終態,
  // 不能記 worker 自己算的 status — 否則 events 會跟 job.json 說兩套話。
  //
  // 優先順位:
  //   (1) terminal.lock の status(有効な終態のみ採用 — readTerminalLock は
  //       corrupt/非終態内容を {status:null} で返すので、null なら無視)
  //   (2) job.json の status が終態ならそれを採用
  //   (3) どちらも終態を提供できない場合(例: lock が corrupt、job.json が stale
  //       "running" のまま)→ 安全な終態フォールバック "failed" を使う。
  //       reconcile と一致するフォールバック;絶対に active status を書かない。
  let finalStatus;
  if (won) {
    finalStatus = status;
  } else {
    const lock = readTerminalLock(stateDir, jobId);
    // lock?.status is null when lock file is corrupt or has non-terminal content.
    // Do NOT fall back to job.json status blindly — it may be stale "running".
    // Only use job.json status if it is already a known terminal status.
    const lockStatus = lock?.status ?? null;
    if (lockStatus !== null) {
      finalStatus = lockStatus;
    } else {
      const jobStatus = readJob(stateDir, jobId)?.status ?? null;
      finalStatus = (jobStatus !== null && TERMINAL_STATUSES.has(jobStatus))
        ? jobStatus
        : "failed"; // safe terminal fallback — never write an active status
    }
  }
  appendEvent(dir, "finalized", { status: finalStatus, by: won ? "worker" : "lost-cas" });
  return 0;
}
