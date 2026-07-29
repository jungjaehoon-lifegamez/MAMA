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
// Supports SESSION_DIR env override for test isolation
const SESSION_DIR = process.env.SESSION_DIR || path.join(os.tmpdir(), 'mama-sessions');
const getSessionFile = () => path.join(SESSION_DIR, `session-${process.ppid}.json`);

// Session expires after 4 hours of inactivity (240 minutes)
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
 * Check if this is the first edit of a file in this session (read-only)
 * Does NOT mark the file - caller should use markFileEdited() after successful operations
 */
function isFirstEdit(filePath) {
  const state = loadSessionState();
  const normalizedPath = normalizePath(filePath);
  return !state.editedFiles.includes(normalizedPath);
}

/**
 * Mark a file as edited in this session
 */
function markFileEdited(filePath) {
  const state = loadSessionState();
  const normalizedPath = normalizePath(filePath);
  if (!state.editedFiles.includes(normalizedPath)) {
    state.editedFiles.push(normalizedPath);
    saveSessionState(state);
  }
}

/**
 * Normalize file path for consistent comparison
 * Platform-aware: only lowercase on case-insensitive systems (macOS, Windows)
 */
function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  // Linux is case-sensitive, macOS/Windows are not
  return process.platform === 'linux' || process.platform === 'freebsd'
    ? resolved
    : resolved.toLowerCase();
}

module.exports = {
  loadSessionState,
  saveSessionState,
  isFirstEdit,
  markFileEdited,
};
