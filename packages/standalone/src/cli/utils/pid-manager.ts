/**
 * PID Manager for MAMA Standalone
 *
 * Manages PID file for daemon process tracking
 */

import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { MAMA_PATHS } from '../config/types.js';
import { expandPath } from '../config/config-manager.js';

/**
 * Process information
 */
export interface ProcessInfo {
  /** Process ID */
  pid: number;
  /** Start time (Unix timestamp) */
  startedAt: number;
}

/**
 * Get the full path to PID file
 */
export function getPidPath(): string {
  return expandPath(MAMA_PATHS.PID);
}

/**
 * Check if PID file exists
 */
export function pidFileExists(): boolean {
  return existsSync(getPidPath());
}

/**
 * Write PID file with process information
 *
 * @param pid - Process ID to write
 */
export async function writePid(pid: number): Promise<void> {
  const pidPath = getPidPath();
  const pidDir = dirname(pidPath);

  // Ensure directory exists
  if (!existsSync(pidDir)) {
    await mkdir(pidDir, { recursive: true });
  }

  const info: ProcessInfo = {
    pid,
    startedAt: Date.now(),
  };

  await writeFile(pidPath, JSON.stringify(info, null, 2), 'utf-8');
}

/**
 * Read process information from PID file
 *
 * @returns Process info or null if file doesn't exist
 */
export async function readPid(): Promise<ProcessInfo | null> {
  const pidPath = getPidPath();

  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const content = await readFile(pidPath, 'utf-8');
    const info = JSON.parse(content) as ProcessInfo;

    // Validate structure
    if (typeof info.pid !== 'number' || typeof info.startedAt !== 'number') {
      // Legacy format: just PID number
      const pid = parseInt(content.trim(), 10);
      if (!isNaN(pid)) {
        return { pid, startedAt: Date.now() };
      }
      return null;
    }

    return info;
  } catch {
    return null;
  }
}

/**
 * Delete PID file
 */
export async function deletePid(): Promise<void> {
  const pidPath = getPidPath();

  if (existsSync(pidPath)) {
    await unlink(pidPath);
  }
}

/**
 * Check if a process with given PID is running
 *
 * @param pid - Process ID to check
 * @returns true if process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if MAMA daemon is currently running
 *
 * @returns Process info if running, null otherwise
 */
export async function isDaemonRunning(): Promise<ProcessInfo | null> {
  const info = await readPid();

  if (!info) {
    return null;
  }

  if (isProcessRunning(info.pid)) {
    return info;
  }

  // Process not running, clean up stale PID file
  await deletePid();
  return null;
}

/**
 * Get uptime in human-readable format
 *
 * @param startedAt - Start timestamp
 * @returns Human-readable uptime string
 */
export function getUptime(startedAt: number): string {
  const uptimeMs = Date.now() - startedAt;
  const seconds = Math.floor(uptimeMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}일 ${hours % 24}시간`;
  }
  if (hours > 0) {
    return `${hours}시간 ${minutes % 60}분`;
  }
  if (minutes > 0) {
    return `${minutes}분 ${seconds % 60}초`;
  }
  return `${seconds}초`;
}

/**
 * Get PID file modification time (for last activity tracking)
 *
 * @returns Modification timestamp or null
 */
export async function getPidFileModTime(): Promise<number | null> {
  const pidPath = getPidPath();

  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const stats = await stat(pidPath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

// Re-export expandPath for convenience
export { expandPath } from '../config/config-manager.js';
