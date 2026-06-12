import { spawn } from "node:child_process";
import readline from "node:readline";

export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1h, codex 版 1.0.18 對齊
const FORCE_KILL_GRACE_MS = 5000;
const STDERR_TAIL_BYTES = 4096;

export function resolveTimeoutMs(env = process.env) {
  const raw = Number(env.DELEGATE_JOB_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function buildClaudeArgs({
  settingsPath,
  permissionMode = "bypassPermissions",
  resumeSessionId,
} = {}) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    settingsPath,
    "--permission-mode",
    permissionMode,
  ];
  if (resumeSessionId) args.push("-r", resumeSessionId);
  return args;
}

// Spawns one headless claude turn. Prompt goes through STDIN, never argv
// (argv leaks to `ps`; large prompts need EPIPE handling — an early-exiting
// child must fail the JOB, not crash the runner).
export function runClaudeTurn({
  binary = "claude",
  args,
  prompt,
  env,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  graceMs = FORCE_KILL_GRACE_MS,
  spawnImpl = spawn,
  onLine = () => {},
  onChild = () => {},
} = {}) {
  return new Promise((resolve) => {
    const outcome = {
      exitCode: null,
      signal: null,
      sessionId: null,
      resultText: null,
      isError: false,
      timedOut: false,
      stderrTail: "",
      stdinError: null,
    };
    let child;
    try {
      child = spawnImpl(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      outcome.isError = true;
      outcome.stderrTail = String(error?.message ?? error);
      resolve(outcome);
      return;
    }
    onChild(child); // hand the live handle to a cancel forwarder
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, graceMs);
      force.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdin.on("error", (error) => {
      outcome.stdinError = error;
    });
    try {
      child.stdin.write(prompt ?? "");
      child.stdin.end();
    } catch (error) {
      outcome.stdinError = outcome.stdinError ?? error;
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      onLine(line);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // tolerate junk — never fail the turn on a noisy line
      }
      if (typeof event.session_id === "string" && !outcome.sessionId) {
        outcome.sessionId = event.session_id;
      }
      if (event.type === "result") {
        outcome.resultText =
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result ?? "");
        outcome.isError = Boolean(event.is_error);
      }
    });

    child.stderr.on("data", (chunk) => {
      outcome.stderrTail = (outcome.stderrTail + chunk.toString()).slice(
        -STDERR_TAIL_BYTES,
      );
    });

    child.on("error", (error) => {
      outcome.isError = true;
      outcome.stderrTail = outcome.stderrTail || String(error?.message ?? error);
      finish();
    });
    child.on("close", (code, signal) => {
      outcome.exitCode = code;
      outcome.signal = signal ?? null;
      finish();
    });
  });
}
