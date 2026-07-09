# grok — changelog

## 0.1.0
- Initial release: headless xAI Grok Build engine adapter over the shared runtime.
  Commands: setup, task, status, wait, logs, result, cancel. Default model
  grok-4.5. Auth delegated to the grok CLI (XAI_API_KEY or `grok login`). Resume
  via `-r <sessionId>`. `logs` surfaces the raw grok stream (thinking + output).
