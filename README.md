# lean-opencode-mcp

A minimal, synchronous/awaitable Model Context Protocol (MCP) server for delegating subagent tasks to the [OpenCode CLI](https://github.com/opencode-ai/opencode) (including OpenCode Zen free models).

## Why `lean-opencode-mcp`?

`Better-OpenCodeMCP` uses a **7-tool async polling architecture** (`opencode`, `opencode_sessions`, `opencode_respond`, `opencode_cancel`, `opencode_health`, `ping`, `Help`). In practice, that architecture adds significant tool-schema overhead and forces the host LLM into multi-turn polling loops (`opencode` → poll `opencode_sessions` → `opencode_respond` → poll again).

`lean-opencode-mcp` replaces all 7 tools with **2 lean tools**:

- **No polling loops**: `opencode_delegate` spawns `opencode run --format json`, streams progress, and awaits completion in a single call.
- **Keepalive progress notifications**: Emits MCP `notifications/progress` every 15 seconds while a task is running (when the client provides a `progressToken`) so long-running tasks do not hit MCP client request timeouts.
- **Native parallel execution**: Invoke multiple `opencode_delegate` tool calls in one turn to run subagents concurrently.
- **Direct multi-turn continuation**: Pass the returned `sessionId` back into `opencode_delegate` instead of juggling separate `taskId` + `opencode_respond` state.
- **Clean Windows spawning**: Resolves the direct `opencode.exe` binary when available so `spawn` can run with `shell: false`, avoiding `cmd.exe` mangling of multi-line prompts.
- **Optional daemon attach**: Supports `attachUrl` (or `OPENCODE_ATTACH_URL`) to connect to a running `opencode serve` daemon and skip CLI cold-start.

---

## Tools

### 1. `opencode_delegate`

Synchronous/awaitable subagent delegation to OpenCode. Spawns `opencode run`, streams NDJSON events while sending 15-second keepalive `notifications/progress` updates, and returns the complete response text, `sessionId`, tools used, and token metrics in a single call.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task` | `string` | Yes | — | Detailed task instructions for the subagent. |
| `cwd` | `string` | No | `process.cwd()` | Working directory path where the subagent should run and edit files. |
| `files` | `string[]` | No | — | Specific file paths to attach (`-f`) as immediate context. |
| `model` | `string` | No | Auto-detected | Model in `provider/model` format (e.g. `opencode/deepseek-v4.1-flash-free`, `opencode/minimax-m3.1-flash-free`, `opencode/mimo-v2.6-flash-free`). Omit to auto-use the default/recent OpenCode model. |
| `agent` | `"build" \| "plan" \| "explore"` | No | `"build"` | `"build"` for file edits/implementation, `"plan"` for read-only analysis/planning, `"explore"` for codebase search. |
| `sessionId` | `string` | No | — | Existing OpenCode `sessionId` to continue a multi-turn conversation with the subagent. |
| `attachUrl` | `string` | No | `OPENCODE_ATTACH_URL` | Optional URL of a running `opencode serve` daemon (e.g. `http://localhost:4096`) to bypass cold-start. |
| `timeoutMs` | `number` | No | `300000` | Timeout in milliseconds. |

#### Response JSON

```json
{
  "status": "completed",
  "sessionId": "ses_...",
  "model": "opencode/deepseek-v4.1-flash-free",
  "cwd": "/path/to/repo",
  "response": "...",
  "toolsUsed": [
    { "tool": "read", "status": "completed", "input": { "filePath": "..." } }
  ],
  "tokens": { "input": 1200, "output": 350, "reasoning": 0 },
  "durationMs": 4210
}
```

On failure or timeout, `status` is `"failed"`, `isError` is `true`, and `error` describes the failure while preserving any partial `response`, `sessionId`, `toolsUsed`, and `tokens`.

---

### 2. `opencode_models`

Checks OpenCode CLI health (`--version`), reports the resolved binary path, reads configured default/recent/favorite models from OpenCode's local state (`model.json`), and optionally queries the live model catalog (`opencode models`).

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `filter` | `string` | No | — | Case-insensitive substring filter (e.g. `"free"`, `"opencode/"`). |
| `includeCatalog` | `boolean` | No | `false` | Set `true` to invoke `opencode models` CLI to list all available models in addition to reading local recent/favorite state. |

#### Response JSON

```json
{
  "cli": {
    "available": true,
    "binary": "C:\\Users\\...\\opencode.exe",
    "version": "1.x.y"
  },
  "defaultModel": "opencode/deepseek-v4.1-flash-free",
  "recent": ["opencode/deepseek-v4.1-flash-free"],
  "favorite": [],
  "filter": "free",
  "catalog": [
    "opencode/deepseek-v4.1-flash-free",
    "opencode/minimax-m3.1-flash-free",
    "opencode/mimo-v2.6-flash-free"
  ]
}
```

---

## Installation & Build

```bash
cd lean-opencode-mcp
npm install
npm run build
```

## Configuration (`mcp_config.json`)

Add `lean-opencode-mcp` to your MCP client's `mcp_config.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["d:/Code/ACPExp/lean-opencode-mcp/dist/index.js"]
    }
  }
}
```

### Optional Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_BIN` | Explicit path to the `opencode` executable. |
| `OPENCODE_MODEL` | Fallback `provider/model` used when OpenCode's `model.json` has no `recent` entries (defaults to `opencode/deepseek-v4.1-flash-free`). |
| `OPENCODE_ATTACH_URL` | Default `opencode serve` URL (e.g. `http://localhost:4096`) when `attachUrl` is not passed per call. |

Example with optional environment variables:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["d:/Code/ACPExp/lean-opencode-mcp/dist/index.js"],
      "env": {
        "OPENCODE_MODEL": "opencode/deepseek-v4.1-flash-free",
        "OPENCODE_ATTACH_URL": "http://localhost:4096"
      }
    }
  }
}
```
