/**
 * Shared helper to read process resource usage via `ps`.
 * Used by both Mock and InteractiveMock.
 */

import { execFileSync } from "node:child_process";

export interface ProcessStats {
  /** Pi process PID. */
  pid: number;
  /** Resident Set Size in kilobytes. */
  rssKb: number;
  /** Total CPU time (user + sys) in seconds. */
  cpuSeconds: number;
}

/**
 * Parse `ps -o cputime=` output (e.g. "0:02.34" or "1:05:30") into seconds.
 */
function parseCpuTime(raw: string): number {
  const parts = raw.trim().split(":");
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  if (parts.length === 3) {
    return (
      parseInt(parts[0], 10) * 3600 +
      parseInt(parts[1], 10) * 60 +
      parseFloat(parts[2])
    );
  }
  return 0;
}

/**
 * Read RSS (KB) and CPU time (seconds) for a given PID via `ps`.
 * Works on macOS and Linux.
 */
export function readProcessStats(pid: number): ProcessStats | null {
  try {
    const out = execFileSync("ps", ["-o", "rss=,cputime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const match = out.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    const rssKb = parseInt(match[1], 10);
    const cpuSeconds = parseCpuTime(match[2]);
    return { pid, rssKb, cpuSeconds };
  } catch {
    return null;
  }
}
