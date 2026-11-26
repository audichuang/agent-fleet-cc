> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。

# imagine skill — 生圖(xAI Grok Imagine / Google Antigravity)(developer notes)

> 改 `skills/imagine/`、`tests/imagine/` 前先讀這份;不放在 `skills/imagine/` 裡的理由同 `docs/codex-dev.md`。

## 定位
**不是 engine。** repo 另一顆 skill(codex)是「把任務委派給另一個 coding agent」;
這顆是一個**能力**:生一張圖。所以它沒有 job 生命週期、沒有
`launch/wait/logs/cancel`、**不用 codex 的 job store**(`scripts/lib/shared/` 不存在)。

契約 —— **磁碟上的檔案就是收據**:一個 HTTP POST 到 xAI,吃 SuperGrok。

## 為什麼不走 grok CLI 的 `image_gen` tool
0.7.0 之前生圖是 `/grok:image`,做法是驅動 grok companion 的 `task` verb 跑一段 canned prompt、
叫 grok 自己呼叫 `image_gen` 再 `cp` 出來。那條路要靠**讀 job 的 raw event stream**才知道圖有沒有
生出來,而且 tier 被歸零時 `image_gen` 會把推銷文當成**成功的** tool result 回來 —— 失敗長得像成功。
HTTP 那條回的是 bytes 或 HTTP status,所以整套 triage(`tool_call_update` 的 wire shape、
`SuperGrok` 子字串比對、`cp` 沒發生的補救分支)全部消失。`/grok:image` 已於此顆上線時從 grok
plugin 移除,不留重複入口。

## agy 引擎已移除(2026-11-26)
Antigravity FAQ 寫明個人方案不支援「wrapping agy inside third-party coding agents」,條款可停權,
所以 `--engine agy` 改成 exit 2。staging、`COPYFILE_EXCL`、殺整棵 process tree 的做法與實測在
移除前的 git 歷史(`docs/imagine-agy-image-audit.md`、`tests/imagine/agy-engine.test.mjs`)。

## 認證:讀 grok CLI 的 token,永遠不寫
`~/.grok/auth.json`(可用 `GROK_AUTH_FILE` 覆寫)是 grok CLI 的檔案。我們**只讀**兩個欄位:
`.key`(OAuth access token)與 `.expires_at`;entry 用 key 前綴 `https://auth.x.ai::` 選,
**不是**拿第一個 key。
- **絕不碰 `.refresh_token`,也絕不寫回這個檔。** auth.x.ai 可能在使用時輪替 refresh token,
  我們在外面 refresh 有機會把使用者從 grok CLI 登出。過期就 fail,訊息叫他跑一次 `grok`。
- 沒有 grok 登入時退回 `XAI_API_KEY`(這顆會裝到別人機器上,不能假設有 grok)。
- 契約細節(token 的 `api:access` scope、6 小時效期、endpoint/payload/response shape、
  ephemeral URL、免費 catalog GET 的重驗食譜)在 `docs/imagine-xai-image-api-audit.md`。
  學到新東西改那份,別在此重抄。

## 進來改要遵守
- **成功判準是磁碟上的檔案**,不是 model 的話也不是 HTTP 200:script 用寫檔後的 `statSync`
  回報 bytes,失敗一律 non-zero exit。
- **`data[0].url` 要立刻下載**。xAI 的 `imgen.x.ai` 資產是短命的,幾分鐘就 404
  (hermes-agent #26942)。優先吃 `b64_json`,只有 URL 時當場抓 bytes,不要把 URL 傳出去。
- **不要在 shipped prose 裡列舉 model 目錄**(root `AGENTS.md` 的規則)。預設寫死一個
  `grok-imagine-image` 可以,清單指向免費的 `GET /v1/image-generation-models`。
  **唯一經 owner 核准的例外**是 `skills/imagine/references/model-and-params.md`:
  它的三 model 比較是 36 次實測的結果,不是抄目錄,免費 GET 也拿不到,所以留著 ——
  代價是它有日期錨點和重驗指令,而且**已經腐爛過一次**(0.1.0 上線前,第 11 行還說預設是
  `-2.0`,程式和實測段是 `grok-imagine-image`)。改那份文件時,先確認每一句「skill default」
  跟 `scripts/imagine.mjs` 的 `model =` 對得上。別把這個例外擴大到其他檔案。
- **Prompt 一律走 `--prompt-file`,不要 heredoc、不要拼進命令列。** prompt 是 model / 使用者
  authored 的文字:它自己含一行 delimiter 就會關掉 here-document,後面那幾行當 shell 執行;
  當成 shell argument 則會被靜默剝掉 on-image text 需要的雙引號。`--out` 可省略(script 自己
  mkdtemp),免得有人在一個 Bash call 算出路徑、再拼進下一個。這條由
  `tests/imagine/skill-structure.test.mjs` 強制:它走過每一份 shipped `.md`,禁 `<<`、要求每個
  提到 script 的 fence 都有 `--prompt-file`。改文件時別想繞過它 —— 它就是那個缺陷的疫苗。
- 測試 hermetic:注入 `fetchImpl` / `authFile`,temp dir 假 auth.json,不連網。

## 細節指向
- **入口只有一個 skill**:`skills/imagine/SKILL.md`(0.3.0 起;`/imagine:image` command 已併入)。
  它是 model-invocable,使用者說要一張圖時 Claude 會自己載入。body 保持 ≤80 行,細節放
  `references/`(one-hop 連結,測試要求連結集合 = 檔案集合)。
- prompt 怎麼寫才生得出好圖(recipe / 反模式):`references/prompt-craft.md`;範例:`references/examples.md`;
  選 model:`references/model-and-params.md`;各種失敗訊息:`references/running.md`。
