# EngineAdapter 合約

雙形態:ProcessAdapter(一次性程序)現行;SessionAdapter(常駐 broker)延後。

## 形態無關五不變量(conformance 驗證對象;日後 SessionAdapter 不得重簽)

1. job 必達終態(completed | failed | cancelled | timed-out),永不卡 running。
2. 事件必寫 events.ndjson(job-created / spawned / engine-event / result / finalized)。
3. cancel 必殺乾淨:整個 process group,孫子不留。
   **已知缺口(2026-08-23,誠實標註,勿當成已滿足):** 這條在 `runWorker` **自己發起**的
   kill 路徑(timeout / stall)上成立 —— `finish()` 會等完剩餘 grace 後同步送整組 SIGKILL,
   刻意排在 resolve 之前,因為 worker-entry 一 resolve 就 `process.exit()`,而 `process.exit()`
   **無視** ref'd handle,任何排程的升級都會隨它消失。**尚未涵蓋**:(a)
   `installCancelForwarder` 自己那條 —— 它從 signal handler 送 TERM,再靠自己的 unref
   `forceExitMs` 退出,同一個空窗;(b) 用 `setsid` 跳出 group 的後代(`spawn.mjs` 一直註明
   射程外)。(a) 是**既有**缺口,不是本輪造成,但在修好之前這條不變量不能被讀成無條件。
4. result 必冪等:重複讀取同一 job 的 result 永遠一致。
5. exitCode 可為 null(session 型引擎無單一退出碼)。

## ProcessAdapter 成員

| 成員 | 型別 | 職責 |
|---|---|---|
| name / engine | string | 顯示名 / 統一 schema 的 engine 值 |
| recursionMarker | string | buildEngineEnv 強制注入的遞迴守衛變數名 |
| wantsWatchdog | boolean | reconcile 雙保險的 watchdog 開關宣告(藍圖 §5.7) |
| firstEventTimeoutMs | number? | **選填**。首輸出看門狗預算:引擎在這段時間內**沒在 stdout 寫出任何非空行**就殺掉,終態 `failed` + errorKind `"stalled"`(刻意與 `timeout` 分開 —— 後者是超出預算,前者是一句都沒說)。防的是 headless 卡在互動式提示(引擎沒死、沒報錯、也不吐事件)。不宣告(或給 `null`)= 不啟用,行為與此欄位存在前完全相同。可以是 **getter**,讓 adapter 按每次 invocation 決定要不要武裝(grok 就靠這個在 `--json-schema` 模式關掉它);worker 是在 `buildInvocation` **之後**才讀,所以 getter 看得到當次模式。給了非 null 的值就必須是正有限數。`validateProcessAdapter` 會擋掉 0/NaN/Infinity/字串,**但production 不呼叫那個 validator**(它是 conformance 測試用的),所以 runWorker 自己也擋:遇到宣告了卻用不了的值,它不武裝、並在 job log 寫一行說清楚 —— 「看起來有防護、其實沒有」是最壞形態,不能安靜當成沒宣告。解除門檻刻意是「stdout 上任何非空行」,**不是** `parseEvent` 解析成功 —— adapter 對 progress / thought / tool 行回 null 是正常的,而非串流模式(JSON-schema)在終端物件前根本沒有可解析事件,拿 parsed 當門檻會保證誤殺健康的 run。stderr 不算解除(互動式提示最可能印在那裡)。解除是永久的(這是啟動關卡,不是 idle watchdog)。代價不對稱所以偏向寧可漏抓:漏抓退回整體 timeoutMs,誤殺直接摧毀使用者的工作。 |
| buildInvocation({job, prompt}) | fn | → { argv, env, stdinPayload } — env 只放顯式注入(profile 等),消毒由 worker 強制 |
| parseEvent(rawLine) | fn | → 正規化事件 \| null;junk 行回 null,永不 throw |
| extractResult(events, exitCode) | fn | → { ok, resultText, sessionId, usage?, error? } — `error` 選填:adapter 從串流解析出的失敗原因,worker 拿它蓋過 stderrTail(供 exit 0 卻在 stdout 宣告失敗的引擎用);沒設就維持原行為 |
| classifyError(stderrTail, exitCode) | fn | → errorKind('auth' \| 'not-installed' \| 'endpoint' \| 'unknown' …) |
| resumeArgs(sessionId) | fn | → 追加 argv 片段(claude:`-r <id>`;agy:`--conversation <id>`) |
