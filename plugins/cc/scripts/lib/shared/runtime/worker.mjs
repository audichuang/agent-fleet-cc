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
import { spawnEngine, killGroupWithGrace, killProcessGroup } from "./spawn.mjs";

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
      clearTimeout(stalledForceTimer);
      resolveWithGroupReaped();
    };
    let forceTimer = null;
    let killInitiated = false;
    let killedAt = null;
    // 不變量 3(「cancel 必殺乾淨:整個 process group,孫子不留」)在 resolve **之前**收尾。
    // 為什麼不能靠 killGroupWithGrace 那個排程的升級:worker-entry 在 runWorker resolve 的
    // 瞬間就 `process.exit()`,而 process.exit **無視 ref'd handle**(ref 過,實測無效),
    // 所以只要 leader 比 grace 先關,那一槍永遠不會開,忽略 TERM 又改掉 stdio 的同 pgid 孫子
    // 就活過了 job 的終態。唯一可靠的時機是 entry 還沒機會退出的此刻。
    //
    // 但**不能立刻開槍**:一個正在「處理」TERM 的後代可能還在做清理(review 重現過:1000ms
    // grace 下做 400ms 清理的孫子被砍斷)。所以先把剩餘的 grace 等完 —— 承諾過的禮貌要守,
    // 只是改由我們自己守到底,而不是交給一個會隨 process.exit 消失的排程。
    // 只在我們真的發過 TERM 的路徑上做;happy path 直接 resolve,一個訊號都不發。
    const resolveWithGroupReaped = () => {
      if (!killInitiated || !child?.pid) return resolve(state);
      const graceMs = deps.graceMs ?? 5000;
      const remaining = Math.max(0, (killedAt ?? Date.now()) + graceMs - Date.now());
      const reap = () => {
        // 刻意**不**先探 leader 的存活。試過,那是錯的:leader 收到 TERM 就自己退出了,探它
        // 必然失敗,於是整組都不殺 —— 而孫子正活在那個 pgid 裡。「leader 死了」不等於
        // 「group 空了」,那正是這整條路徑存在的理由。
        // 代價明說:pid 消失且 pgid 被系統回收時,這一槍會打到不相干的 group。窗口是
        // 「close 到 killedAt+grace」這段,而不是 kill 之後的整個 grace;pgid 回收本身
        // 未被重現。拿「一定殺乾淨」換「可能誤傷」是刻意的取捨 —— 反過來已經被證明會讓
        // 忽略 TERM 的引擎後代永久存活(不變量 3 因此曾經是空的)。
        killProcessGroup(child.pid, "SIGKILL", deps.killImpl ?? process.kill);
        resolve(state);
      };
      if (remaining === 0) return reap();
      (deps.scheduleImpl ?? setTimeout)(reap, remaining);
    };
    // 首輸出看門狗(adapter 選填 firstEventTimeoutMs)。要防的不是「跑太久」——
    // 那是下面的 timeoutMs——而是「headless 的 run 被互動式提示卡住」:引擎沒死、
    // 沒報錯、stdout 一個位元組都不吐,只是在等一個永遠不會來的人類。引擎特定的
    // 觸發路徑與錨點寫在各自 adapter 宣告 firstEventTimeoutMs 的地方(引擎知識不進
    // shared runtime)。
    //
    // 刻意做成「按行為判斷」而不是「事前猜憑證」:client 端無法可靠判斷一份憑證能不能用
    // (試過,兩個方向都會錯),但「該說話的時候不說話」是可觀測的。
    //
    // **解除訊號是 stdout 上任何非空行,不是「parseEvent 解析成功的事件」。** 這點是
    // 血換來的:用 parsed 當門檻會把健康的 run 殺掉,因為 adapter 對自己不需要正規化的
    // 行回 null 是完全正常的(progress / thought / tool 事件),而非串流模式(例如
    // JSON-schema)在終端物件之前根本沒有任何「可解析事件」—— 那等於保證誤殺一個支援中的
    // 功能。把門檻放在「引擎在 stdout 上講話了嗎」才對齊真正的威脅:被互動式提示擋住的
    // 引擎是**完全安靜**的。
    //
    // 兩邊代價不對稱,所以刻意偏向寧可漏抓:漏抓 = 退回既有的整體 timeoutMs 行為(引擎自己
    // 的 OAuth 等待本身也有上限);誤殺 = 直接摧毀使用者健康的工作。stderr 不算解除,
    // 互動式提示最可能就印在那裡。adapter 沒宣告這個欄位 → 完全不啟用。
    let firstEventTimer = null;
    let stalledForceTimer = null;
    // 只讀一次並記進 state:firstEventTimeoutMs 允許是 per-invocation 的 getter,
    // 事後重讀可能拿到不同的值(下一次 buildInvocation 之後就變了),於是錯誤訊息會印出
    // 「within nullms」這種東西。武裝時看到的數字才是該報的數字。
    const firstEventTimeoutMs = adapter.firstEventTimeoutMs;
    state.armedFirstEventTimeoutMs = null;
    const armFirstEventWatchdog = () => {
      // null/undefined = 沒宣告 = 不啟用,這是合約。但宣告了一個「用不了」的值(0、NaN、
      // Infinity、字串)絕不能安靜當成沒宣告 —— 使用者會以為自己開了防護。記一筆事件,
      // 讓它至少查得到,而不是無聲無息。
      if (firstEventTimeoutMs === null || firstEventTimeoutMs === undefined) return;
      if (!Number.isFinite(firstEventTimeoutMs) || firstEventTimeoutMs <= 0) {
        // 寫 job log,不是 appendEvent:EVENT_TYPES 是 spec §3 的最小正規化集(還被
        // deepEqual 釘住,且 readEvents 會過濾未知型別),不該為一句診斷去擴充它 ——
        // 而 appendEvent 對未知型別是 throw 的,在這裡等於炸掉整個 job。
        logStream.write(
          `[worker] firstEventTimeoutMs was declared as ${JSON.stringify(String(firstEventTimeoutMs))} ` +
            "but is not a positive finite number of ms — the stall guard is NOT armed for this job.\n",
        );
        return;
      }
      firstEventTimer = (deps.scheduleImpl ?? setTimeout)(() => {
        state.stalledBeforeFirstEvent = true;
        state.armedFirstEventTimeoutMs = firstEventTimeoutMs;
        killInitiated = true;
        killedAt = Date.now();
        // 這道關開火就代表整體 timeoutMs 沒有意義了(引擎連話都沒講),而且兩個計時器都
        // 活著會讓終態自相矛盾:status 說 timed-out、errorKind 說 stalled。先把它拆掉。
        clearTimeout(timer);
        const graceMs = deps.graceMs ?? 5000;
        killGroupWithGrace(child.pid, {
          graceMs,
          scheduleImpl: deps.scheduleImpl ?? setTimeout,
          // killImpl 也要傳下去:少了它,這個注入縫只有一半有效 —— reap 走 deps.killImpl
          // 而 TERM 走真 process.kill,於是測試看得到 SIGKILL 卻看不到 SIGTERM,
          // 「等完 grace 才開槍」就變成不可觀測(review 抓到)。
          ...(deps.killImpl ? { killImpl: deps.killImpl } : {}),
        });
        const forceMs = graceMs + (deps.forceResolveExtraMs ?? 200);
        // 這個 force-resolve 刻意**不** unref(與上面 timeoutMs 路徑不同)。一個真的卡住的
        // 引擎不會關 stdout,所以 'close' 永遠不來 —— 這個計時器是唯一能讓 job 落終態的
        // 東西。unref 掉它,event loop 就會在 finalize 之前把 process 抽乾,job 永遠留在
        // running(spec §5 不變量 1:job 必達終態)。timeoutMs 那條路徑 unref 是安全的,
        // 因為那裡引擎通常已經吐過東西、stdout 會關。
        // 用獨立變數:共用 forceTimer 會蓋掉 timeoutMs 那條已排程的 handle,讓一個 ref'd
        // 計時器沒人清得掉,活到自己燒完為止。
        stalledForceTimer = (deps.scheduleImpl ?? setTimeout)(() => finish(), forceMs);
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
      killInitiated = true;
      killedAt = Date.now();
      // 整體預算先到就把首輸出看門狗拆掉。兩個期限重疊時(例如 --timeout-ms 119000 對 120s 的
      // 看門狗,或兩者相等),child 若在 grace 期間沒關,看門狗還武裝著就會再開火一次,結果
      // status 是 timed-out 而 error/errorKind 是 stalled —— 持久化的終態自相矛盾。
      disarmFirstEventWatchdog();
      const graceMs = deps.graceMs ?? 5000;
      killGroupWithGrace(child.pid, {
        graceMs,
        scheduleImpl: deps.scheduleImpl ?? setTimeout,
        // killImpl 也要傳下去:少了它,這個注入縫只有一半有效 —— reap 走 deps.killImpl
        // 而 TERM 走真 process.kill,於是測試看得到 SIGKILL 卻看不到 SIGTERM,
        // 「等完 grace 才開槍」就變成不可觀測(review 抓到)。
        ...(deps.killImpl ? { killImpl: deps.killImpl } : {}),
      });
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
      // 引擎在 stdout 上講話了 → 撤掉首輸出看門狗。門檻是「任何非空行」而不是
      // 「parseEvent 解析成功」,理由見上面 armFirstEventWatchdog 的註解(用 parsed 當門檻
      // 會誤殺非串流模式與只吐 progress/thought 的健康 run)。
      if (line.trim()) disarmFirstEventWatchdog();
      logStream.write(line + "\n");
      let parsed;
      try {
        parsed = adapter.parseEvent(line);
      } catch {
        parsed = null; // parseEvent 永不 fatal
      }
      if (parsed) {
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
    // 看門狗開火過就是失敗,不管 child 之後怎麼收尾:一個會處理 SIGTERM 的引擎可以吐一個
    // 合法終端事件再 exit 0,那樣 job 會落成 completed、而我們剛剛才因為它卡住把它殺掉。
    outcome.stalledBeforeFirstEvent ||
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
    const stalledPrefix = `engine wrote nothing to stdout within ${outcome.armedFirstEventTimeoutMs}ms and was killed — a headless run should not be silent this long; the usual cause is the engine blocking on an interactive prompt (e.g. an expired credential falling through to browser OAuth)`;
    error = stdinFailed
      ? `stdin: ${outcome.stdinError.code ?? outcome.stdinError.message}`
      // 只截 stderr,不截前綴。整串一起 .slice(-500) 的話,夠長的 stderr 會把「我們為什麼
      // 殺掉它」連同開頭的授權 URL 一起吃光,只留下一段無頭的引擎雜訊。
      : outcome.stalledBeforeFirstEvent
        ? `${stalledPrefix}${outcome.stderrTail ? `. engine stderr: ${outcome.stderrTail.slice(-300)}` : "."}`
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
