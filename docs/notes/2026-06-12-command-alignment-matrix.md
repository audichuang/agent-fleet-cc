# 指令對齊矩陣(2026-06-12 記錄,決策留待第二階段)

使用者觀察:三 plugin 的動詞層指令未對齊。盤點如下(`plugins/*/commands/` 實際掃描):

| 指令 | codex | antigravity | delegate |
|---|:---:|:---:|:---:|
| status / result / cancel / setup | ✓ | ✓ | ✓ |
| task | ✗(rescue 扮演) | ✓ | ✓ |
| execute-plan | ✓ | ✗ | ✓ |
| review / adversarial-review | ✓ | ✓ | ✗ |
| rescue | ✓ | ✓ | ✗ |
| handoff | ✓ | ✓ | ✗ |
| attach | ✓ | ✗ | ✗ |
| image | ✗ | ✓ | ✗ |

裁定(與使用者確認):

1. **語意性缺口不強求對齊**:`image` 是 agy 獨有能力、`attach` 依賴 codex 常駐 broker,
   其他引擎補了也沒有對應語意。
2. **其餘動詞的取捨留給第二階段 brainstorm**(候選:delegate 補 review/adversarial-review/
   rescue、antigravity 補 execute-plan、codex 補 task 或明文記錄 rescue 即 task),
   實作搭共享地基(spec §5)的便車,避免先對齊再重構做兩次工。
3. 生命週期四指令(status/result/cancel/setup)已天然對齊,維持。

關聯:`docs/specs/2026-06-12-agent-fleet-merge-design.md` §5–§6。
