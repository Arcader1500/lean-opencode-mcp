import { spawn } from "node:child_process";
import { detectDefaultModel, resolveOpenCodeBinary } from "./executable.js";

export interface DelegateOptions {
  task: string;
  cwd?: string;
  files?: string[];
  model?: string;
  agent?: "build" | "plan" | "explore";
  sessionId?: string;
  attachUrl?: string;
  timeoutMs?: number;
}

export interface ToolUsageRecord {
  tool: string;
  status: string;
  input?: Record<string, unknown>;
}

export interface TokenCounts {
  input: number;
  output: number;
  reasoning: number;
}

export interface DelegateResult {
  status: "completed" | "failed";
  sessionId?: string;
  model: string;
  cwd: string;
  response: string;
  toolsUsed: ToolUsageRecord[];
  tokens: TokenCounts;
  durationMs: number;
  error?: string;
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

/**
 * Runs a delegated OpenCode CLI task using `--format json` NDJSON streaming
 * and returns a structured result with accumulated text, tool usage, and tokens.
 */
export function runOpenCodeTask(
  options: DelegateOptions,
  onProgress?: (msg: string) => void
): Promise<DelegateResult> {
  const startTime = Date.now();
  const binary = resolveOpenCodeBinary();
  const effectiveModel = options.model || detectDefaultModel();
  const effectiveAgent = options.agent || "build";
  const effectiveCwd = options.cwd || process.cwd();
  const effectiveAttachUrl = options.attachUrl || process.env.OPENCODE_ATTACH_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args: string[] = [
    "run",
    "-m",
    effectiveModel,
    "--format",
    "json",
    "--agent",
    effectiveAgent,
  ];

  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }
  if (effectiveAttachUrl) {
    args.push("--attach", effectiveAttachUrl);
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
    const toolsUsed: ToolUsageRecord[] = [];
    const tokens: TokenCounts = { input: 0, output: 0, reasoning: 0 };
    let errorMessage: string | undefined;
    let stderrOutput = "";
    let stdoutBuffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (overrideError?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }

      const finalError = overrideError ?? errorMessage;
      const result: DelegateResult = {
        status: finalError ? "failed" : "completed",
        sessionId,
        model: effectiveModel,
        cwd: effectiveCwd,
        response,
        toolsUsed,
        tokens,
        durationMs: Date.now() - startTime,
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
          const rawInput = event.part?.state?.input;
          const input =
            rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : undefined;

          toolsUsed.push(
            input ? { tool: toolName, status: toolStatus, input } : { tool: toolName, status: toolStatus }
          );
          onProgress?.(`[tool] ${toolName} (${toolStatus})`);
          break;
        }

        case "step_finish": {
          const stepTokens = event.part?.tokens;
          if (stepTokens && typeof stepTokens === "object") {
            if (typeof stepTokens.input === "number") {
              tokens.input += stepTokens.input;
            }
            if (typeof stepTokens.output === "number") {
              tokens.output += stepTokens.output;
            }
            if (typeof stepTokens.reasoning === "number") {
              tokens.reasoning += stepTokens.reasoning;
            }
          }
          break;
        }

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
        finish(timeoutErr);
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
      finish(`Failed to spawn OpenCode (${binary}): ${err.message}`);
    });

    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim().length > 0) {
        handleLine(stdoutBuffer);
        stdoutBuffer = "";
      }

      if (errorMessage) {
        finish(errorMessage);
        return;
      }

      if (code !== 0) {
        const detail = stderrOutput.trim();
        const reason =
          code !== null
            ? `OpenCode exited with code ${code}`
            : `OpenCode terminated by signal ${signal ?? "unknown"}`;
        finish(detail ? `${reason}: ${detail}` : reason);
        return;
      }

      finish();
    });
  });
}
