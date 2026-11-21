import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 3000;

export interface GitChangeSummary {
  changedFiles: string[];
  diffStat?: string;
}

/**
 * Collects a short summary of uncommitted changes in `cwd`.
 * Returns `undefined` when `cwd` is not a git repository (or git is unavailable),
 * so callers can attach the summary only when there is something to show.
 */
export async function collectGitSummary(cwd: string): Promise<GitChangeSummary | undefined> {
  let statusOutput: string;
  try {
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    statusOutput = stdout;
  } catch {
    return undefined;
  }

  const changedFiles = statusOutput
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.trim());

  let diffStat: string | undefined;
  try {
    const { stdout } = await run("git", ["diff", "--stat"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    if (trimmed.length > 0) {
      diffStat = trimmed;
    }
  } catch {
    // A missing diff stat must not discard the changed-file list.
  }

  return { changedFiles, ...(diffStat ? { diffStat } : {}) };
}
