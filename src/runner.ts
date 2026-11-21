import { spawn } from "node:child_process";
import {
  detectDefaultModel,
  getFallbackModels,
  resolveOpenCodeBinary,
} from "./executable.js";
import { collectGitSummary, type GitChangeSummary } from "./gitSummary.js";

export interface DelegateOptions {
  task: string;
  cwd?: string;
  files?: string[];
  model?: string;
  agent?: "build" | "plan" | "explore";
  sessionId?: string;
  serverUrl?: string;
  timeoutMs?: number;
}

export interface DelegateResult {
  status: "completed" | "failed";
  sessionId?: string;
  model: string;
  response: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
  gitSummary?: GitChangeSummary;
}

interface OpenCodeRawEvent {
  type?: unknown;
  sessionID?: unknown;
  part?: {
    text?: unknown;
    tool?: unknown;
    state?: {
      status?: unknown;
      input?: unknown;
    };
    tokens?: {
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
    };
  };
  error?: {
    name?: unknown;
    data?: {
      message?: unknown;
    };
  };
}

const DEFAULT_TIMEOUT_MS = 300_000;

const MAX_FAILOVER_ATTEMPTS = 2;

const RETRYABLE_MODEL_ERROR_PATTERN =
  /rate.?limit|429|quota|overloaded|unavailable|provider|model.*not.*found|502|503|504|capacity/i;

/**
 * Returns true when a failure looks like a provider/model availability problem
 * that another model could plausibly solve (rate limits, quota, outages).
 */
export function isRetryableModelError(errorMsg?: string): boolean {
  if (!errorMsg) {
    return false;
  }
  return RETRYABLE_MODEL_ERROR_PATTERN.test(errorMsg);
}

/**
 * Runs a single OpenCode CLI attempt with `--format json` NDJSON streaming and
 * returns a structured result with accumulated text, tool usage, and tokens.
 */
async function runSingleAttempt(
  options: DelegateOptions,
  modelToUse: string,
  effectiveCwd: string,
  onProgress?: (msg: string) => void
): Promise<DelegateResult> {
  const startTime = Date.now();
  const binary = resolveOpenCodeBinary();
  const effectiveAgent = options.agent || "build";
  const effectiveServerUrl = options.serverUrl || process.env.OPENCODE_SERVER_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args: string[] = [
    "run",
    "-m",
    modelToUse,
    "--format",
    "json",
    "--agent",
    effectiveAgent,
    "--auto",
  ];

  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }
  if (effectiveServerUrl) {
    args.push("--server", effectiveServerUrl);
  }
  if (options.files && options.files.length > 0) {
    for (const file of options.files) {
      args.push("-f", file);
    }
  }
  args.push(options.task);

  const useShell =
    process.platform === "win32" && !binary.toLowerCase().endsWith(".exe");

  return new Promise<DelegateResult>((resolve) => {
    let sessionId: string | undefined = options.sessionId;
    let response = "";
    let toolCallCount = 0;
    let errorMessage: string | undefined;
    let stderrOutput = "";
    let stdoutBuffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = async (overrideError?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }

      const finalError = overrideError ?? errorMessage;
      const durationMs = Date.now() - startTime;
      const gitSummary = await collectGitSummary(effectiveCwd);
      const result: DelegateResult = {
        status: finalError ? "failed" : "completed",
        sessionId,
        model: modelToUse,
        response,
        toolCallCount,
        durationMs,
        ...(gitSummary ? { gitSummary } : {}),
      };
      if (finalError) {
        result.error = finalError;
      }
      resolve(result);
    };

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      let event: OpenCodeRawEvent;
      try {
        event = JSON.parse(line) as OpenCodeRawEvent;
      } catch {
        return;
      }

      if (!event || typeof event !== "object") {
        return;
      }

      if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
        sessionId = event.sessionID;
      }

      switch (event.type) {
        case "step_start":
          break;

        case "text": {
          const text = event.part?.text;
          if (typeof text === "string") {
            response += text;
            if (text.length > 0) {
              onProgress?.(text);
            }
          }
          break;
        }

        case "tool_use": {
          const toolName =
            typeof event.part?.tool === "string" ? event.part.tool : "unknown";
          const toolStatus =
            typeof event.part?.state?.status === "string"
              ? event.part.state.status
              : "unknown";
          toolCallCount += 1;
          onProgress?.(`[tool] ${toolName} (${toolStatus})`);
          break;
        }

        case "step_finish":
          break;

        case "error": {
          const msg =
            typeof event.error?.data?.message === "string"
              ? event.error.data.message
              : typeof event.error?.name === "string"
                ? event.error.name
                : "OpenCode error event";
          errorMessage = msg;
          break;
        }

        default:
          break;
      }
    };

    const child = spawn(binary, args, {
      cwd: effectiveCwd,
      env: process.env,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const timeoutErr = `OpenCode task timed out after ${timeoutMs}ms`;
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore kill errors if process already exited
        }
        void finish(timeoutErr);
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        handleLine(line);
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      void finish(`Failed to spawn OpenCode (${binary}): ${err.message}`);
    });

    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim().length > 0) {
        handleLine(stdoutBuffer);
        stdoutBuffer = "";
      }

      if (errorMessage) {
        void finish(errorMessage);
        return;
      }

      if (code !== 0) {
        const detail = stderrOutput.trim();
        const reason =
          code !== null
            ? `OpenCode exited with code ${code}`
            : `OpenCode terminated by signal ${signal ?? "unknown"}`;
        void finish(detail ? `${reason}: ${detail}` : reason);
        return;
      }

      void finish();
    });
  });
}

/**
 * Runs a delegated OpenCode CLI task, rotating to fallback models when a fresh
 * session fails for a retryable model/provider reason before any tool ran.
 */
export async function runOpenCodeTask(
  options: DelegateOptions,
  onProgress?: (msg: string) => void
): Promise<DelegateResult> {
  const effectiveCwd = options.cwd || process.cwd();
  const primaryModel = options.model || detectDefaultModel();

  let result = await runSingleAttempt(options, primaryModel, effectiveCwd, onProgress);
  if (options.sessionId || result.status !== "failed") {
    return result;
  }

  const fallbacks = isRetryableModelError(result.error)
    ? getFallbackModels(primaryModel).slice(0, MAX_FAILOVER_ATTEMPTS)
    : [];

  let prevModel = primaryModel;
  for (const nextModel of fallbacks) {
    if (result.toolCallCount > 0 || !isRetryableModelError(result.error)) {
      break;
    }
    onProgress?.(
      `[failover] ${prevModel} failed (${result.error}), retrying with ${nextModel}...`
    );
    result = await runSingleAttempt(options, nextModel, effectiveCwd, onProgress);
    prevModel = nextModel;
  }

  return result;
}
