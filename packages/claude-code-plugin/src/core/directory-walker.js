/**
 * Directory Walker for AGENTS.md Discovery
 *
 * Walks up directory tree from a file path to find AGENTS.md files.
 * Inspired by OhMyOpenCode's directory-agents-injector pattern.
 *
 * Features:
 * - Synchronous directory traversal (required for hook performance)
 * - Project root detection (.git, package.json, pnpm-workspace.yaml, .claude)
 * - Configurable max depth and skip options
 * - Sorted results by distance (closest first)
 * - Skips node_modules, .git, dist directories
 *
 * @module directory-walker
 */

const fs = require('fs');
const path = require('path');

// Project root markers (in priority order)
const PROJECT_ROOT_MARKERS = ['.git', 'package.json', 'pnpm-workspace.yaml', '.claude'];

// Directories to skip during traversal
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'out']);

/**
 * Find project root by looking for marker files/directories
 * Searches up from startPath until finding a marker or reaching filesystem root
 *
 * @param {string} startPath - Starting path (file or directory)
 * @returns {string|null} Project root path or null if not found
 */
function findProjectRoot(startPath) {
  if (!startPath || typeof startPath !== 'string') {
    return null;
  }

  try {
    // Start from directory (if startPath is a file, use its directory)
    let currentPath = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);

    // Walk up until finding marker or reaching root
    while (currentPath !== path.dirname(currentPath)) {
      for (const marker of PROJECT_ROOT_MARKERS) {
        const markerPath = path.join(currentPath, marker);
        if (fs.existsSync(markerPath)) {
          return currentPath;
        }
      }

      currentPath = path.dirname(currentPath);
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Find AGENTS.md files in parent directories
 *
 * @param {string} filePath - Absolute path of file being read/edited
 * @param {Object} options - Configuration options
 * @param {number} options.maxDepth - Max parent directories to walk (default: 5)
 * @param {boolean} options.skipRoot - Skip project root AGENTS.md (default: true)
 * @param {string} options.projectRoot - Project root path (auto-detected if not provided)
 * @returns {Array<{path: string, content: string, distance: number}>} Found AGENTS.md files
 *   - path: absolute path to AGENTS.md
 *   - content: file contents
 *   - distance: 0 = same dir, 1 = parent, etc.
 *   - Sorted by distance ascending (closest first)
 */
function findAgentsMdFiles(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return [];
  }

  const { maxDepth = 5, skipRoot = true, projectRoot = null } = options;

  try {
    // Determine starting directory
    let currentDir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);

    // Auto-detect project root if not provided
    let detectedRoot = projectRoot;
    if (!detectedRoot) {
      detectedRoot = findProjectRoot(currentDir);
    }

    const results = [];
    let depth = 0;

    // Walk up directory tree
    while (depth < maxDepth && currentDir !== path.dirname(currentDir)) {
      // Check if we've reached filesystem root
      if (currentDir === path.dirname(currentDir)) {
        break;
      }

      // Skip if we're in a skip directory
      const dirName = path.basename(currentDir);
      if (SKIP_DIRS.has(dirName)) {
        currentDir = path.dirname(currentDir);
        depth++;
        continue;
      }

      // Check for AGENTS.md in current directory
      const agentsMdPath = path.join(currentDir, 'AGENTS.md');
      if (fs.existsSync(agentsMdPath)) {
        // Skip project root AGENTS.md if requested
        if (skipRoot && detectedRoot && currentDir === detectedRoot) {
          currentDir = path.dirname(currentDir);
          depth++;
          continue;
        }

        try {
          const content = fs.readFileSync(agentsMdPath, 'utf8');
          results.push({
            path: agentsMdPath,
            content,
            distance: depth,
          });
        } catch (error) {
          // Skip files we can't read
        }
      }

      // Move to parent directory
      currentDir = path.dirname(currentDir);
      depth++;
    }

    // Sort by distance (closest first)
    results.sort((a, b) => a.distance - b.distance);

    return results;
  } catch (error) {
    return [];
  }
}

module.exports = {
  findAgentsMdFiles,
  findProjectRoot,
  PROJECT_ROOT_MARKERS,
  SKIP_DIRS,
};
