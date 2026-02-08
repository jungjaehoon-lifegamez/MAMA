/**
 * Find rule files (.claude/rules/*.md, .copilot-instructions) relative to a file.
 * Inspired by OhMyOpenCode's rules-injector pattern.
 *
 * @module rules-finder
 */

const fs = require('fs');
const path = require('path');

/**
 * Find applicable rule files for a given file path.
 *
 * Search patterns (in order):
 * 1. {projectRoot}/.copilot-instructions (single file, always applies if exists)
 * 2. {projectRoot}/.claude/rules/*.md (project-level rules)
 * 3. Walk up from filePath: each parent dir's .claude/rules/*.md
 *
 * @param {string} filePath - Absolute path of file being read/edited
 * @param {Object} options - Configuration options
 * @param {string} options.projectRoot - Project root path (required)
 * @returns {Array<Object>} Array of rule objects sorted by distance (closest first)
 *   Each object: { path: string, content: string, distance: number, matchReason: string }
 *   matchReason: "copilot-instructions (always apply)" | "claude-rules" | "directory-rules"
 */
function findRuleFiles(filePath, options = {}) {
  const { projectRoot } = options;

  if (!projectRoot) {
    throw new Error('projectRoot option is required');
  }

  if (!filePath) {
    throw new Error('filePath is required');
  }

  const rules = [];
  const seenPaths = new Set();

  // 1. Check for .copilot-instructions at project root (always applies if exists)
  const copilotPath = path.join(projectRoot, '.copilot-instructions');
  if (fs.existsSync(copilotPath) && fs.statSync(copilotPath).isFile()) {
    try {
      const content = fs.readFileSync(copilotPath, 'utf8');
      if (content.trim()) {
        rules.push({
          path: copilotPath,
          content,
          distance: 0,
          matchReason: 'copilot-instructions (always apply)',
        });
        seenPaths.add(copilotPath);
      }
    } catch (error) {
      // Skip files that can't be read
    }
  }

  // 2. Check project-level .claude/rules/*.md
  const projectRulesDir = path.join(projectRoot, '.claude', 'rules');
  if (fs.existsSync(projectRulesDir) && fs.statSync(projectRulesDir).isDirectory()) {
    try {
      const files = fs.readdirSync(projectRulesDir);
      files.forEach((file) => {
        if (file.endsWith('.md')) {
          const rulePath = path.join(projectRulesDir, file);
          if (!seenPaths.has(rulePath)) {
            try {
              const content = fs.readFileSync(rulePath, 'utf8');
              if (content.trim()) {
                rules.push({
                  path: rulePath,
                  content,
                  distance: 0,
                  matchReason: 'claude-rules',
                });
                seenPaths.add(rulePath);
              }
            } catch (error) {
              // Skip files that can't be read
            }
          }
        }
      });
    } catch (error) {
      // Skip if directory can't be read
    }
  }

  // 3. Walk up from filePath looking for .claude/rules/*.md in parent directories
  let currentDir = path.dirname(filePath);
  let distance = 1;

  while (currentDir !== projectRoot && currentDir !== path.dirname(currentDir)) {
    const dirRulesPath = path.join(currentDir, '.claude', 'rules');
    if (fs.existsSync(dirRulesPath) && fs.statSync(dirRulesPath).isDirectory()) {
      try {
        const files = fs.readdirSync(dirRulesPath);
        files.forEach((file) => {
          if (file.endsWith('.md')) {
            const rulePath = path.join(dirRulesPath, file);
            if (!seenPaths.has(rulePath)) {
              try {
                const content = fs.readFileSync(rulePath, 'utf8');
                if (content.trim()) {
                  rules.push({
                    path: rulePath,
                    content,
                    distance,
                    matchReason: 'directory-rules',
                  });
                  seenPaths.add(rulePath);
                }
              } catch (error) {
                // Skip files that can't be read
              }
            }
          }
        });
      } catch (error) {
        // Skip if directory can't be read
      }
    }

    currentDir = path.dirname(currentDir);
    distance += 1;
  }

  // Sort by distance ascending (closest rules first)
  rules.sort((a, b) => a.distance - b.distance);

  return rules;
}

module.exports = {
  findRuleFiles,
};
