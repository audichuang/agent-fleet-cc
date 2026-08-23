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
  // F4:引擎 child 是 detached(自己的 pgid),終端的 SIGINT(Ctrl-C)只送到
  // foreground companion,不會到引擎 — 不轉發就孤兒化。SIGHUP(終端關閉)同理。
  // 三個訊號共用同一 handler:kill child group(+ optional forceExit)。
  const CANCEL_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const sig of CANCEL_SIGNALS) proc.once(sig, handler);
  return {
    onChild(child) {
      childPid = child.pid;
      if (terminated) killSequence(childPid); // signal 先於 spawn 到達
    },
    dispose() {
      for (const sig of CANCEL_SIGNALS) proc.removeListener(sig, handler);
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
  // adapter 缺 recursionMarker 時 buildEngineEnv 會 throw — 與 buildInvocation
  // 路徑對稱,用 try/catch + earlyFinalize 接住(spec §5 不變量 1:job 必達終態)。
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
  let child;
  const outcome = await new Promise((resolve) => {
    const state = {
      exitCode: null,
      signal: null,
      stderrTail: "",
      stdinError: null,
      spawnError: null,
      timedOut: false,
      stalledBeforeFirstEvent: false,
    };
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
      clearTimeout(firstEventTimer);
      resolve(state);
    };
    let forceTimer = null;
    // 首事件看門狗(adapter 選填 firstEventTimeoutMs)。要防的不是「跑太久」——
    // 那是下面的 timeoutMs——而是「headless 的 run 被互動式提示卡住」:引擎沒死、
    // 沒報錯、也不會吐任何事件,只是在等一個永遠不會來的人類。grok 1.0.5 有一條
    // 這樣的路:cached token 過期/legacy 時,authenticate_after_cached_token_unavailable
    // 會遞迴選到互動式 grok.com 並「把原本的 headless meta 換掉」
    // (xai-grok-shell/src/agent/mvp_agent/agent_ops.rs:1412-1416),然後 OAuth callback
    // 等 600s(auth/oidc/login.rs AUTH_CALLBACK_TIMEOUT)。`--background` 時完全看不見。
    //
    // 刻意做成「按行為判斷」而不是「事前猜憑證」:client 端無法可靠判斷一份憑證能不能用
    // (試過,兩個方向都會錯),但「該說話的時候不說話」是可觀測的。任何未來的互動式卡頓
    // 也一併被這道關接住,不必再認得它。
    //
    // 只有 stdout 上**解析成功的引擎事件**能解除它 —— 不是任意 raw 行、更不是 stderr。
    // 互動式提示很可能就印在 stderr,拿 stderr 解除等於自廢這道關。
    // adapter 沒宣告這個欄位 → 完全不啟用,行為與先前逐位元組相同。
    let firstEventTimer = null;
    const firstEventTimeoutMs = adapter.firstEventTimeoutMs;
    const armFirstEventWatchdog = () => {
      if (!Number.isFinite(firstEventTimeoutMs) || firstEventTimeoutMs <= 0) return;
      firstEventTimer = (deps.scheduleImpl ?? setTimeout)(() => {
        state.stalledBeforeFirstEvent = true;
        const graceMs = deps.graceMs ?? 5000;
        killGroupWithGrace(child.pid, { graceMs, scheduleImpl: deps.scheduleImpl ?? setTimeout });
        const forceMs = graceMs + (deps.forceResolveExtraMs ?? 200);
        // 這個 force-resolve 刻意**不** unref(與上面 timeoutMs 路徑不同)。一個真的卡住的
        // 引擎不會關 stdout,所以 'close' 永遠不來 —— 這個計時器是唯一能讓 job 落終態的
        // 東西。unref 掉它,event loop 就會在 finalize 之前把 process 抽乾,job 永遠留在
        // running(spec §5 不變量 1:job 必達終態)。timeoutMs 那條路徑 unref 是安全的,
        // 因為那裡引擎通常已經吐過東西、stdout 會關。
        forceTimer = (deps.scheduleImpl ?? setTimeout)(() => finish(), forceMs);
      }, firstEventTimeoutMs);
      firstEventTimer?.unref?.();
    };
    const disarmFirstEventWatchdog = () => {
      if (!firstEventTimer) return;
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    };
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
    armFirstEventWatchdog();

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
      // Live-streaming hook: hand the raw line to the caller the instant it arrives
      // (before parse/log), so a foreground caller can stream progress with no
      // file-tail race. Contract: the sink MUST be synchronous and non-blocking —
      // it is called inline on the readline 'line' event and its return value is
      // ignored, so this applies NO backpressure. A slow sink slows stdout
      // consumption (and could bloat a downstream buffer); a throwing sink is
      // isolated here and never breaks the job (streaming is cosmetic; the
      // authoritative result is rebuilt from in-memory events).
      if (deps.onLine) {
        try {
          deps.onLine(line);
        } catch {
          // swallow: job integrity outranks a broken progress sink
        }
      }
      logStream.write(line + "\n");
      let parsed;
      try {
        parsed = adapter.parseEvent(line);
      } catch {
        parsed = null; // parseEvent 永不 fatal
      }
      if (parsed) {
        // 引擎開口了 → 撤掉首事件看門狗。放在 parsed 分支內(而非上面的 raw 行)是刻意的:
        // 一行解析不出來的雜訊不算「引擎在跑」。
        disarmFirstEventWatchdog();
        // type: "engine-event" 最後覆蓋 — parseEvent 若回傳引擎自訂的 type 欄位
        // (如 {type:"result",...}),正規化 type 仍必須是 "engine-event"(spec §3)。
        // parsed fields 先攤平,讓 extractResult 能直接存取 e.kind / e.text 等;
        // raw 保存原始行供稽核重播;type: "engine-event" 放最後覆蓋任何 parsed.type。
        const engineEvent = { ...parsed, raw: line, type: "engine-event" };
        events.push(engineEvent);
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
  // Release engine stdio held open after we settle — chiefly the timeout path, where
  // a grandchild can still hold the child's stdout so 'close' never fires and the
  // pipe keeps the event loop alive. A FOREGROUND caller now exits via
  // process.exitCode (natural drain, not process.exit()), so a lingering read handle
  // would hang it forever; destroy the streams so the loop can drain. No-op once the
  // child has already closed normally.
  try {
    child?.stdout?.destroy();
  } catch {}
  try {
    child?.stderr?.destroy();
  } catch {}
  // Await the log flush before returning: logStream.write() is async, so without
  // this a caller that reads logFilePath right after runWorker (e.g. renderResult's
  // readLogTail, or a detached worker about to process.exit) can miss the tail.
  // Resolve on 'finish' or 'error' so a stream error can never hang the job.
  await new Promise((resolve) => {
    logStream.on("error", resolve);
    logStream.end(resolve);
  });

  let result = { ok: false, resultText: null, sessionId: null, usage: null };
  try {
    result = { ...result, ...adapter.extractResult(events, outcome.exitCode) };
  } catch {}
  // stdinError 只在 exitCode 非 0 時才算失敗。引擎若提前關閉 stdin(EPIPE)
  // 但正常退出(exitCode 0),這是合法行為(引擎不需要讀完整個 stdin)。
  // 把 EPIPE + exitCode=0 誤判為失敗會讓移植的 adapter 出現假紅燈。
  const stdinFailed = Boolean(outcome.stdinError) && outcome.exitCode !== 0;
  const failed =
    Boolean(outcome.spawnError) ||
    stdinFailed ||
    outcome.exitCode !== 0 ||
    !result.ok;
  const status = outcome.timedOut ? "timed-out" : failed ? "failed" : "completed";
  let error = null;
  let errorKind = null;
  if (status !== "completed") {
    // result.error(選填)是 adapter 從**串流**解析出的失敗原因。優先於 stderrTail:
    // 引擎可能 exit 0 卻只在 stdout 宣告失敗,此時 stderr 是空的,退回
    // "engine exited nonzero" 會持久化一句與 exitCode 矛盾的假話。沒設這欄的
    // adapter 拿到 undefined → 行為完全不變。
    const adapterError = typeof result.error === "string" && result.error ? result.error : null;
    // 首事件看門狗開火時,引擎的 stderr 常常正是最有用的線索(例如那個沒人會去點的
    // OAuth 授權 URL),所以保留它,只在前面說清楚我們為什麼把它殺掉。
    const stalledPrefix = `engine produced no event within ${adapter.firstEventTimeoutMs}ms and was killed — a headless run should not be silent this long; the usual cause is the engine blocking on an interactive prompt (e.g. an expired credential falling through to browser OAuth)`;
    error = stdinFailed
      ? `stdin: ${outcome.stdinError.code ?? outcome.stdinError.message}`
      : outcome.stalledBeforeFirstEvent
        ? `${stalledPrefix}${outcome.stderrTail ? `. engine stderr: ${outcome.stderrTail}` : "."}`.slice(-500)
        : (outcome.spawnError || adapterError || outcome.stderrTail || "engine exited nonzero").slice(-500);
    try {
      // "stalled" ≠ "timeout": timeout 是「跑太久超出預算」,stalled 是「一開口都沒開就啞了」。
      // 分開才問得出「這是不是又一次互動式卡頓」,而不是跟長任務混在一起。
      errorKind = outcome.stalledBeforeFirstEvent
        ? "stalled"
        : outcome.timedOut
          ? "timeout"
          : adapter.classifyError(outcome.spawnError || adapterError || outcome.stderrTail, outcome.exitCode);
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
  //   (1) terminal.lock 的 status(只採用有效終態 — readTerminalLock 對
  //       corrupt/非終態內容回傳 {status:null},null 時忽略)
  //   (2) job.json 的 status 若已是終態則採用
  //   (3) 兩者都無法提供終態時(如 lock corrupt、job.json 仍是 stale "running")
  //       → 安全終態回退 "failed";與 reconcile 一致;絕不寫出 active status。
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
