#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  detectDefaultModel,
  readRecentAndFavoriteModels,
  resolveOpenCodeBinary,
} from "./executable.js";
import {
  runOpenCodeTask,
  type DelegateOptions,
  type DelegateResult,
} from "./runner.js";

const execFileAsync = promisify(execFile);

const PROGRESS_INTERVAL_MS = 15_000;
const CLI_VERSION_TIMEOUT_MS = 5_000;
const CLI_MODELS_TIMEOUT_MS = 15_000;

export const opencodeDelegateSchema = z.object({
  task: z.string().min(1).describe("Detailed task instructions for the subagent."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory path where the subagent should run and edit files."),
  files: z
    .array(z.string())
    .optional()
    .describe("Specific file paths to attach (-f) as immediate context."),
  model: z
    .string()
    .optional()
    .describe(
      "Model in provider/model format (e.g. opencode/deepseek-v4.1-flash-free, opencode/minimax-m3.1-flash-free, opencode/mimo-v2.6-flash-free). Omit to auto-use the default/recent OpenCode model."
    ),
  agent: z
    .enum(["build", "plan", "explore"])
    .optional()
    .default("build")
    .describe(
      '"build" for file edits/implementation, "plan" for read-only analysis/planning, "explore" for codebase search.'
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      "Existing OpenCode sessionId to continue a multi-turn conversation with the subagent."
    ),
  serverUrl: z
    .string()
    .optional()
    .describe(
      "Optional URL of a running opencode server (--server) if overriding OpenCode's default background service."
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(300_000)
    .describe("Timeout in milliseconds (default 300000)."),
});

export const opencodeModelsSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring filter (e.g. "free", "opencode/").'),
  includeCatalog: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true to invoke opencode models CLI to list all available models in addition to reading local recent/favorite state."
    ),
});

function toToolInputSchema(schema: z.ZodTypeAny, name: string): Tool["inputSchema"] {
  const raw = zodToJsonSchema(schema, name) as {
    definitions?: Record<
      string,
      { properties?: Record<string, object>; required?: string[] }
    >;
    properties?: Record<string, object>;
    required?: string[];
  };
  const def = raw.definitions?.[name] ?? raw;
  return {
    type: "object",
    properties: def.properties ?? {},
    required: def.required ?? [],
  };
}

export const TOOLS: Tool[] = [
  {
    name: "opencode_delegate",
    description:
      "Synchronous/awaitable subagent delegation to OpenCode (and OpenCode Zen free models). Spawns `opencode run`, waits for completion while sending keepalive progress notifications, and returns the complete response text, sessionId (for multi-turn follow-ups), tools used, and token metrics in a single call. Supports parallel execution by invoking multiple `opencode_delegate` calls in one turn.",
    inputSchema: toToolInputSchema(opencodeDelegateSchema, "opencode_delegate"),
  },
  {
    name: "opencode_models",
    description:
      'Check OpenCode CLI health, resolved binary path, configured default/recent models from OpenCode state, and optionally query the live model catalog (`opencode models`) filtered by keyword (e.g. "free" or "opencode/").',
    inputSchema: toToolInputSchema(opencodeModelsSchema, "opencode_models"),
  },
];

async function sendProgressNotification(
  server: Server,
  progressToken: string | number | undefined,
  progress: number,
  message: string
): Promise<void> {
  if (progressToken === undefined || progressToken === null) {
    return;
  }

  try {
    await server.notification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message,
      },
    });
  } catch {
    // Non-fatal: ignore notification errors if client closed or does not support them
  }
}

async function runCliCommand(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  const useShell =
    process.platform === "win32" && !binary.toLowerCase().endsWith(".exe");

  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    shell: useShell,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
}

function filterModelList(models: string[], filter?: string): string[] {
  const needle = filter?.trim().toLowerCase();
  if (!needle) {
    return models;
  }
  return models.filter((model) => model.toLowerCase().includes(needle));
}

export async function handleOpenCodeDelegate(
  args: unknown,
  server: Server,
  progressToken?: string | number
): Promise<CallToolResult> {
  const parsed = opencodeDelegateSchema.parse(args ?? {});
  const options: DelegateOptions = {
    task: parsed.task,
    cwd: parsed.cwd,
    files: parsed.files,
    model: parsed.model,
    agent: parsed.agent,
    sessionId: parsed.sessionId,
    serverUrl: parsed.serverUrl,
    timeoutMs: parsed.timeoutMs,
  };

  const startTime = Date.now();
  let latestActivity = "Starting OpenCode subagent...";
  let progressTick = 0;

  await sendProgressNotification(server, progressToken, progressTick, latestActivity);

  const keepalive = setInterval(() => {
    progressTick += 1;
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const snippet = latestActivity.replace(/\s+/g, " ").trim().slice(-150);
    const message = snippet
      ? `[${elapsedSec}s] ${snippet}`
      : `[${elapsedSec}s] OpenCode subagent running...`;
    void sendProgressNotification(server, progressToken, progressTick, message);
  }, PROGRESS_INTERVAL_MS);

  let result: DelegateResult;
  try {
    result = await runOpenCodeTask(options, (msg) => {
      latestActivity = msg;
    });
  } finally {
    clearInterval(keepalive);
  }

  await sendProgressNotification(
    server,
    progressToken,
    progressTick + 1,
    result.status === "completed"
      ? `OpenCode subagent completed in ${result.durationMs}ms.`
      : `OpenCode subagent failed: ${result.error ?? "unknown error"}`
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: result.status === "failed",
  };
}

export async function handleOpenCodeModels(args: unknown): Promise<CallToolResult> {
  const parsed = opencodeModelsSchema.parse(args ?? {});
  const binary = resolveOpenCodeBinary();
  const defaultModel = detectDefaultModel();
  const { recent, favorite } = readRecentAndFavoriteModels();

  const cli: {
    available: boolean;
    binary: string;
    version?: string;
    error?: string;
  } = {
    available: false,
    binary,
  };

  try {
    const versionOut = await runCliCommand(binary, ["--version"], CLI_VERSION_TIMEOUT_MS);
    cli.available = true;
    cli.version = versionOut.trim();
  } catch (error) {
    cli.error = error instanceof Error ? error.message : String(error);
  }

  const payload: {
    cli: typeof cli;
    defaultModel: string;
    recent: string[];
    favorite: string[];
    filter?: string;
    catalog?: string[];
    catalogError?: string;
  } = {
    cli,
    defaultModel,
    recent: filterModelList(recent, parsed.filter),
    favorite: filterModelList(favorite, parsed.filter),
  };

  if (parsed.filter) {
    payload.filter = parsed.filter;
  }

  if (parsed.includeCatalog) {
    try {
      const modelsOut = await runCliCommand(binary, ["models"], CLI_MODELS_TIMEOUT_MS);
      const allModels = modelsOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      payload.catalog = filterModelList(allModels, parsed.filter);
    } catch (error) {
      payload.catalogError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: false,
  };
}

export function createServer(): Server {
  const server = new Server(
    {
      name: "lean-opencode-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const toolName = request.params.name;
      const progressToken = (
        request.params._meta as { progressToken?: string | number } | undefined
      )?.progressToken;

      try {
        switch (toolName) {
          case "opencode_delegate":
            return await handleOpenCodeDelegate(
              request.params.arguments,
              server,
              progressToken
            );
          case "opencode_models":
            return await handleOpenCodeModels(request.params.arguments);
          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown tool: ${toolName}`,
                },
              ],
              isError: true,
            };
        }
      } catch (error) {
        if (error instanceof ZodError) {
          const issues = error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; ");
          return {
            content: [
              {
                type: "text",
                text: `Invalid arguments for ${toolName}: ${issues}`,
              },
            ],
            isError: true,
          };
        }

        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${toolName}: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = () => {
    void server
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}

if (!process.env.VITEST) {
  main().catch((error) => {
    console.error("Fatal error starting lean-opencode-mcp:", error);
    process.exit(1);
  });
}
