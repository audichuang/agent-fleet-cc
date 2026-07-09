# EngineAdapter 合約

雙形態:ProcessAdapter(一次性程序)現行;SessionAdapter(常駐 broker)延後。

## 形態無關五不變量(conformance 驗證對象;日後 SessionAdapter 不得重簽)

1. job 必達終態(completed | failed | cancelled | timed-out),永不卡 running。
2. 事件必寫 events.ndjson(job-created / spawned / engine-event / result / finalized)。
3. cancel 必殺乾淨:整個 process group,孫子不留。
4. result 必冪等:重複讀取同一 job 的 result 永遠一致。
5. exitCode 可為 null(session 型引擎無單一退出碼)。

## ProcessAdapter 成員

| 成員 | 型別 | 職責 |
|---|---|---|
| name / engine | string | 顯示名 / 統一 schema 的 engine 值 |
| recursionMarker | string | buildEngineEnv 強制注入的遞迴守衛變數名 |
| wantsWatchdog | boolean | reconcile 雙保險的 watchdog 開關宣告(藍圖 §5.7) |
| buildInvocation({job, prompt}) | fn | → { argv, env, stdinPayload } — env 只放顯式注入(profile 等),消毒由 worker 強制 |
| parseEvent(rawLine) | fn | → 正規化事件 \| null;junk 行回 null,永不 throw |
| extractResult(events, exitCode) | fn | → { ok, resultText, sessionId, usage? } |
| classifyError(stderrTail, exitCode) | fn | → errorKind('auth' \| 'not-installed' \| 'endpoint' \| 'unknown' …) |
| resumeArgs(sessionId) | fn | → 追加 argv 片段(claude:`-r <id>`;agy:`--conversation <id>`) |
