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
| firstEventTimeoutMs | number? | **選填**。首輸出看門狗預算:引擎在這段時間內**沒在 stdout 寫出任何非空行**就殺掉,終態 `failed` + errorKind `"stalled"`(刻意與 `timeout` 分開 —— 後者是超出預算,前者是一句都沒說)。防的是 headless 卡在互動式提示(引擎沒死、沒報錯、也不吐事件)。不宣告(或給 `null`)= 不啟用,行為與此欄位存在前完全相同。可以是 **getter**,讓 adapter 按每次 invocation 決定要不要武裝(grok 就靠這個在 `--json-schema` 模式關掉它);worker 是在 `buildInvocation` **之後**才讀,所以 getter 看得到當次模式。給了非 null 的值就必須是正有限數(0/NaN/字串會被 `validateProcessAdapter` 擋掉 —— 靜默不武裝是最壞形態)。解除門檻刻意是「stdout 上任何非空行」,**不是** `parseEvent` 解析成功 —— adapter 對 progress / thought / tool 行回 null 是正常的,而非串流模式(JSON-schema)在終端物件前根本沒有可解析事件,拿 parsed 當門檻會保證誤殺健康的 run。stderr 不算解除(互動式提示最可能印在那裡)。解除是永久的(這是啟動關卡,不是 idle watchdog)。代價不對稱所以偏向寧可漏抓:漏抓退回整體 timeoutMs,誤殺直接摧毀使用者的工作。 |
| buildInvocation({job, prompt}) | fn | → { argv, env, stdinPayload } — env 只放顯式注入(profile 等),消毒由 worker 強制 |
| parseEvent(rawLine) | fn | → 正規化事件 \| null;junk 行回 null,永不 throw |
| extractResult(events, exitCode) | fn | → { ok, resultText, sessionId, usage?, error? } — `error` 選填:adapter 從串流解析出的失敗原因,worker 拿它蓋過 stderrTail(供 exit 0 卻在 stdout 宣告失敗的引擎用);沒設就維持原行為 |
| classifyError(stderrTail, exitCode) | fn | → errorKind('auth' \| 'not-installed' \| 'endpoint' \| 'unknown' …) |
| resumeArgs(sessionId) | fn | → 追加 argv 片段(claude:`-r <id>`;agy:`--conversation <id>`) |
