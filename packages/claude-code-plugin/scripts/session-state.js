#!/usr/bin/env node
/**
 * Session State Manager for MAMA Hooks
 *
 * Tracks edited files within a Claude Code session to:
 * - PreToolUse: Show contracts only on first edit of each file
 * - PostToolUse: Track what's been edited for smart reminders
 *
 * Uses parent process ID (Claude Code) as session identifier.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Session file in temp directory, keyed by parent process ID
const SESSION_DIR = path.join(os.tmpdir(), 'mama-sessions');
const getSessionFile = () => path.join(SESSION_DIR, `session-${process.ppid}.json`);

// Session expires after 4 hours of inactivity
const SESSION_EXPIRY_MS = 4 * 60 * 60 * 1000;

/**
 * Load current session state
 */
function loadSessionState() {
  try {
    const sessionFile = getSessionFile();
    if (!fs.existsSync(sessionFile)) {
      return createEmptyState();
    }

    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

    // Check expiry
    if (Date.now() - data.lastActivity > SESSION_EXPIRY_MS) {
      return createEmptyState();
    }

    return data;
  } catch {
    return createEmptyState();
  }
}

/**
 * Save session state
 */
function saveSessionState(state) {
  try {
    // Ensure directory exists
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    state.lastActivity = Date.now();
    fs.writeFileSync(getSessionFile(), JSON.stringify(state, null, 2));
  } catch {
    // Silent fail - don't break hooks
  }
}

/**
 * Create empty session state
 */
function createEmptyState() {
  return {
    sessionId: `${process.ppid}-${Date.now()}`,
    editedFiles: [],
    contractsShown: {}, // filePath -> timestamp
    lastActivity: Date.now(),
  };
}

/**
 * Check if this is the first edit of a file in this session
 */
function isFirstEdit(filePath) {
  const state = loadSessionState();
  const normalizedPath = normalizePath(filePath);

  if (state.editedFiles.includes(normalizedPath)) {
    return false;
  }

  // Mark as edited
  state.editedFiles.push(normalizedPath);
  saveSessionState(state);
  return true;
}

/**
 * Mark that contracts were shown for a file
 */
function markContractsShown(filePath) {
  const state = loadSessionState();
  state.contractsShown[normalizePath(filePath)] = Date.now();
  saveSessionState(state);
}

/**
 * Check if contracts were already shown for this file
 */
function wereContractsShown(filePath) {
  const state = loadSessionState();
  return !!state.contractsShown[normalizePath(filePath)];
}

/**
 * Normalize file path for consistent comparison
 */
function normalizePath(filePath) {
  return path.resolve(filePath).toLowerCase();
}

/**
 * Clean up old session files (call occasionally)
 */
function cleanupOldSessions() {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      return;
    }

    const files = fs.readdirSync(SESSION_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      const stat = fs.statSync(filePath);

      // Remove files older than expiry
      if (now - stat.mtimeMs > SESSION_EXPIRY_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // Silent fail
  }
}

module.exports = {
  loadSessionState,
  saveSessionState,
  isFirstEdit,
  markContractsShown,
  wereContractsShown,
  cleanupOldSessions,
};
