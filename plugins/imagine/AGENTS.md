> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> 本檔只寫 imagine 這顆的**增量**。

# imagine plugin — xAI Grok Imagine 生圖

## 定位
**不是 engine plugin。** fleet 其他四顆(codex/antigravity/cc/grok)都是「把任務委派給另一個
coding agent」;這顆是一個**能力**:呼叫 xAI 的圖片 API 生一張圖。所以它沒有 job 生命週期、
沒有 `launch/wait/logs/cancel`、**不用 shared runtime**(`scripts/lib/shared/` 不存在,
`sync-shared.mjs` 也不該把它加進去)。一個 HTTP POST 就是全部。

## 為什麼不走 grok CLI 的 `image_gen` tool
0.7.0 之前生圖是 `/grok:image`,做法是驅動 grok companion 的 `task` verb 跑一段 canned prompt、
叫 grok 自己呼叫 `image_gen` 再 `cp` 出來。那條路要靠**讀 job 的 raw event stream**才知道圖有沒有
生出來,而且 tier 被歸零時 `image_gen` 會把推銷文當成**成功的** tool result 回來 —— 失敗長得像成功。
HTTP 那條回的是 bytes 或 HTTP status,所以整套 triage(`tool_call_update` 的 wire shape、
`SuperGrok` 子字串比對、`cp` 沒發生的補救分支)全部消失。`/grok:image` 已於此顆上線時從 grok
plugin 移除,不留重複入口。

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
- 測試 hermetic:注入 `fetchImpl` 與 `authFile`,temp dir 假 auth.json,不連網。

## 細節指向
- prompt 怎麼寫才生得出好圖(recipe / 範例 / 反模式 / 選 model):`skills/imagine-prompts/SKILL.md`。
  `commands/image.md` 在花 quota 前會先叫你讀它。
