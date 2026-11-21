import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ModelEntry {
  providerID?: unknown;
  modelID?: unknown;
}

interface ModelStateFile {
  recent?: unknown;
  favorite?: unknown;
}

const DEFAULT_FALLBACK_MODEL = "opencode/deepseek-v4.1-flash-free";

const FREE_DEFAULT_MODELS = [
  "opencode/deepseek-v4.1-flash-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/mimo-v2.6-flash-free",
];

/**
 * Resolves the OpenCode CLI executable path.
 * On Windows, prefers a direct `.exe` path so `spawn` can run with `shell: false`,
 * preventing `cmd.exe` from corrupting multi-line prompt arguments.
 */
export function resolveOpenCodeBinary(): string {
  const envBin = process.env.OPENCODE_BIN?.trim();
  if (envBin) {
    return envBin;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const candidates = [
      join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
      join(homedir(), ".opencode", "bin", "opencode.exe"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "opencode";
}

function getModelStatePath(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "opencode", "model.json");
}

function formatModelEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const formatted: string[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as ModelEntry;
    if (
      typeof entry.providerID === "string" &&
      entry.providerID.length > 0 &&
      typeof entry.modelID === "string" &&
      entry.modelID.length > 0
    ) {
      formatted.push(`${entry.providerID}/${entry.modelID}`);
    }
  }
  return formatted;
}

/**
 * Reads recent and favorite models from OpenCode's `model.json` state file.
 */
export function readRecentAndFavoriteModels(): { recent: string[]; favorite: string[] } {
  const modelPath = getModelStatePath();
  if (!existsSync(modelPath)) {
    return { recent: [], favorite: [] };
  }

  try {
    const raw = readFileSync(modelPath, "utf8");
    const parsed = JSON.parse(raw) as ModelStateFile;
    if (!parsed || typeof parsed !== "object") {
      return { recent: [], favorite: [] };
    }

    return {
      recent: formatModelEntries(parsed.recent),
      favorite: formatModelEntries(parsed.favorite),
    };
  } catch {
    return { recent: [], favorite: [] };
  }
}

/**
 * Detects the default OpenCode model from the most recently used model in `model.json`,
 * falling back to `OPENCODE_MODEL` or `"opencode/deepseek-v4.1-flash-free"`.
 */
export function detectDefaultModel(): string {
  const { recent } = readRecentAndFavoriteModels();
  if (recent.length > 0) {
    return recent[0];
  }
  return process.env.OPENCODE_MODEL || DEFAULT_FALLBACK_MODEL;
}

/**
 * Builds the ordered, deduplicated list of models to try when `primaryModel`
 * fails for a retryable reason: recent models first, then favorites, then the
 * standard free defaults. The primary model itself is excluded.
 */
export function getFallbackModels(primaryModel: string): string[] {
  const { recent, favorite } = readRecentAndFavoriteModels();
  const candidates = [...recent, ...favorite, ...FREE_DEFAULT_MODELS];

  const seen = new Set<string>();
  const fallbacks: string[] = [];
  for (const candidate of candidates) {
    if (candidate === primaryModel || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    fallbacks.push(candidate);
  }
  return fallbacks;
}
