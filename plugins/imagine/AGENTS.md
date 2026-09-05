> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> 本檔只寫 imagine 這顆的**增量**。

# imagine plugin — 生圖(xAI Grok Imagine / Google Antigravity)

## 定位
**不是 engine plugin。** fleet 其他四顆(codex/antigravity/cc/grok)都是「把任務委派給另一個
coding agent」;這顆是一個**能力**:生一張圖。所以它沒有 job 生命週期、沒有
`launch/wait/logs/cancel`、**不用 shared runtime**(`scripts/lib/shared/` 不存在,
`sync-shared.mjs` 也不該把它加進去)。

兩個引擎共用同一份契約 —— **磁碟上的檔案就是收據**:
- `--engine grok`(預設):一個 HTTP POST 到 xAI,吃 SuperGrok。
- `--engine agy`(0.2.0 加):spawn Antigravity CLI,用它內建的 `generate_image` tool,
  吃使用者的 Google 帳號,**完全不需要 API key**。細節見下面「agy 引擎」。

## 為什麼不走 grok CLI 的 `image_gen` tool
0.7.0 之前生圖是 `/grok:image`,做法是驅動 grok companion 的 `task` verb 跑一段 canned prompt、
叫 grok 自己呼叫 `image_gen` 再 `cp` 出來。那條路要靠**讀 job 的 raw event stream**才知道圖有沒有
生出來,而且 tier 被歸零時 `image_gen` 會把推銷文當成**成功的** tool result 回來 —— 失敗長得像成功。
HTTP 那條回的是 bytes 或 HTTP status,所以整套 triage(`tool_call_update` 的 wire shape、
`SuperGrok` 子字串比對、`cp` 沒發生的補救分支)全部消失。`/grok:image` 已於此顆上線時從 grok
plugin 移除,不留重複入口。

## agy 引擎:驅動 agent,但不相信 agent 的話
0.2.0 之前這顆只有 HTTP 一條路,理由是上面那段(驅動 agent + `cp`,失敗長得像成功)。agy 這條
之所以能加進來而不重蹈覆轍,是因為**成功判準沒有變**:script 叫 agy 把圖存到一個絕對路徑,
然後自己 `statSync` 那個路徑。agy 回 `status: SUCCESS` 但沒有檔案 = 失敗,錯誤訊息把 agy
說的話原樣引回去。這條規則就是 `tests/imagine/agy-engine.test.mjs` 裡那個
「a SUCCESS with no file is a failure」——拿掉 `statSync` 會有四個測試同時變紅。

- **prompt 走 argv array,不經 shell。** `spawn(bin, [...])` 沒有 word splitting、沒有引號剝除、
  沒有 here-document 可關,所以 wrapper prompt 可以安全地把使用者的 prompt 原樣嵌進去。
  這是 `--prompt-file` 那條規則的同一個理由,不是例外。
- **`--dangerously-skip-permissions` 是必要的**(headless 沒人回答權限提示)。`cwd` 設成輸出檔
  的目錄,是為了讓 agy 用相對路徑時落在我們預期的位置 —— **它不是沙箱**:權限被跳過的 agent
  用絕對路徑照樣哪裡都能去。真要圍起來得靠 agy 自己的 `--sandbox`,那個還沒驗過(見 audit doc
  的 Still unverified)。
- **絕對路徑是關鍵。** 只說「current working directory」時 agy 會把圖丟到 `$HOME`(實測)。
  tool 一律先寫進 `~/.gemini/antigravity-cli/brain/<conversation-id>/<ImageName>_<epoch>.jpg`,
  搬到我們要的位置是 agent 事後做的,所以那個 brain 路徑只出現在**錯誤訊息**裡當線索,
  不是程式讀的路徑 —— 它沒有文件、會隨 agy 版本變。
- **副檔名照位元組修正**:sniff `FF D8 FF` / `89 50 4E 47`,和 xAI 那條同一個承諾。
- **`--model` / `--resolution` / `--quality` 在 agy 上直接 exit 2**,不能默默吃掉:被丟掉的
  `--model` 是一張使用者沒要求、卻照樣付錢的圖。
- 契約證據(tool 參數、無 key 實測、落檔行為、重驗食譜)在
  `docs/imagine-agy-image-audit.md`。學到新東西改那份。

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
  **唯一經 owner 核准的例外**是 `skills/imagine-prompts/references/model-and-params.md`:
  它的三 model 比較是 36 次實測的結果,不是抄目錄,免費 GET 也拿不到,所以留著 ——
  代價是它有日期錨點和重驗指令,而且**已經腐爛過一次**(0.1.0 上線前,第 11 行還說預設是
  `-2.0`,程式和實測段是 `grok-imagine-image`)。改那份文件時,先確認每一句「plugin default」
  跟 `scripts/imagine.mjs` 的 `model =` 對得上。別把這個例外擴大到其他檔案。
- **Prompt 一律走 `--prompt-file`,不要 heredoc、不要拼進命令列。** prompt 是 model / 使用者
  authored 的文字:它自己含一行 delimiter 就會關掉 here-document,後面那幾行當 shell 執行;
  當成 shell argument 則會被靜默剝掉 on-image text 需要的雙引號。`--out` 可省略(script 自己
  mkdtemp),免得有人在一個 Bash call 算出路徑、再拼進下一個。這條由
  `tests/imagine/plugin-structure.test.mjs` 強制:它走過每一份 shipped `.md`,禁 `<<`、要求每個
  提到 script 的 fence 都有 `--prompt-file`。改文件時別想繞過它 —— 它就是那個缺陷的疫苗。
- 測試 hermetic:注入 `fetchImpl` / `authFile`(xAI)與 `spawnImpl`(agy),temp dir 假 auth.json、
  假 agy 行程,不連網也不需要裝 agy。

## 細節指向
- prompt 怎麼寫才生得出好圖(recipe / 範例 / 反模式 / 選 model):`skills/imagine-prompts/SKILL.md`。
  `commands/image.md` 在花 quota 前會先叫你讀它。
