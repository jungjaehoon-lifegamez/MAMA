const path = require('path');

// Code file extensions considered for hook file processing
const CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.scala',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
]);

// Files/folders to skip when scanning hooks.
const SKIP_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.json$/i,
  /\.ya?ml$/i,
  /\.toml$/i,
  /\.ini$/i,
  /\.env/i,
  /\.lock$/i,
  /\.gitignore$/i,
  /LICENSE/i,
  /README/i,
  /\/(?:test|tests)\//i,
  /\.test\./i,
  /\.spec\./i,
  /\/docs?\//i,
  /\/examples?\//i,
  /node_modules\//i,
];

function shouldProcessFile(filePath) {
  if (!filePath) {
    return false;
  }

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

module.exports = {
  CODE_EXTENSIONS,
  SKIP_PATTERNS,
  shouldProcessFile,
};
