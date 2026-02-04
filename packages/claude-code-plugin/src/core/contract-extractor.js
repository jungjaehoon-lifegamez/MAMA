/**
 * Contract Extractor for MAMA v2
 *
 * Extracts API contracts, function signatures, and type definitions
 * from code changes using simple pattern matching.
 *
 * Design Philosophy:
 * - Simple regex patterns for common cases (80% coverage)
 * - Main Claude handles complex cases (20%)
 * - Transparent: All extractions visible to Main Claude
 */

/**
 * Extract API endpoint contracts from code
 *
 * Detects patterns like:
 * - app.post('/api/auth/register', ...)
 * - router.get('/users/:id', ...)
 * - @PostMapping("/api/users")
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted contracts
 */
function extractApiContracts(code, filePath = '') {
  const contracts = [];

  // Express/Koa style: app.METHOD('/path', ...)
  const expressPattern =
    /(?:app|router)\.(get|post|put|patch|delete|options)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = expressPattern.exec(code)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];

    // Try to extract request/response schema
    const bodyMatch = code.match(/req\.body\s*[=:]\s*{([^}]+)}/);
    const responseMatch = code.match(/res\.json\s*\(\s*{([^}]+)}/);

    contracts.push({
      type: 'api_endpoint',
      method,
      path,
      request: bodyMatch ? `{${bodyMatch[1]}}` : 'unknown',
      response: responseMatch ? `{${responseMatch[1]}}` : 'unknown',
      file: filePath,
      confidence: bodyMatch && responseMatch ? 0.9 : 0.6,
    });
  }

  // Spring style: @PostMapping("/api/users")
  const springPattern = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*['"]([^'"]+)['"]/gi;

  while ((match = springPattern.exec(code)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];

    contracts.push({
      type: 'api_endpoint',
      method,
      path,
      request: 'unknown',
      response: 'unknown',
      file: filePath,
      confidence: 0.5, // Lower confidence (no schema info)
    });
  }

  return contracts;
}

/**
 * Extract function signatures from code
 *
 * Detects patterns like:
 * - function createUser(email, password) { ... }
 * - const validateEmail = (email) => { ... }
 * - async def process_order(order_id): ...
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted function signatures
 */
function extractFunctionSignatures(code, filePath = '') {
  const signatures = [];

  // JavaScript/TypeScript function declarations
  const jsFuncPattern = /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gi;
  let match;

  while ((match = jsFuncPattern.exec(code)) !== null) {
    const name = match[1];
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    signatures.push({
      type: 'function_signature',
      name,
      params,
      file: filePath,
      confidence: 0.8,
    });
  }

  // Arrow functions
  const arrowPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/gi;

  while ((match = arrowPattern.exec(code)) !== null) {
    const name = match[1];
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    signatures.push({
      type: 'function_signature',
      name,
      params,
      file: filePath,
      confidence: 0.8,
    });
  }

  // Python function definitions
  const pyFuncPattern = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gi;

  while ((match = pyFuncPattern.exec(code)) !== null) {
    const name = match[1];
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    signatures.push({
      type: 'function_signature',
      name,
      params,
      file: filePath,
      confidence: 0.8,
    });
  }

  return signatures;
}

/**
 * Extract type definitions from code
 *
 * Detects patterns like:
 * - interface User { ... }
 * - type LoginRequest = { ... }
 * - class UserDTO { ... }
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted type definitions
 */
function extractTypeDefinitions(code, filePath = '') {
  const types = [];

  // TypeScript interfaces
  const interfacePattern = /interface\s+(\w+)\s*{([^}]+)}/gi;
  let match;

  while ((match = interfacePattern.exec(code)) !== null) {
    const name = match[1];
    const fields = match[2]
      .split(/[;\n]/)
      .map((f) => f.trim())
      .filter((f) => f)
      .slice(0, 5); // Limit to 5 fields for brevity

    types.push({
      type: 'type_definition',
      kind: 'interface',
      name,
      fields,
      file: filePath,
      confidence: 0.9,
    });
  }

  // TypeScript type aliases
  const typePattern = /type\s+(\w+)\s*=\s*{([^}]+)}/gi;

  while ((match = typePattern.exec(code)) !== null) {
    const name = match[1];
    const fields = match[2]
      .split(/[;\n,]/)
      .map((f) => f.trim())
      .filter((f) => f)
      .slice(0, 5);

    types.push({
      type: 'type_definition',
      kind: 'type',
      name,
      fields,
      file: filePath,
      confidence: 0.9,
    });
  }

  return types;
}

/**
 * Extract all contracts from code
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Object} All extracted contracts
 */
function extractContracts(code, filePath = '') {
  return {
    apiEndpoints: extractApiContracts(code, filePath),
    functionSignatures: extractFunctionSignatures(code, filePath),
    typeDefinitions: extractTypeDefinitions(code, filePath),
  };
}

/**
 * Format contract for MAMA decision
 *
 * @param {Object} contract - Extracted contract
 * @returns {Object} MAMA decision format
 */
function formatContractForMama(contract) {
  if (contract.type === 'api_endpoint') {
    const topic = `contract_${contract.method.toLowerCase()}_${contract.path.replace(/[^a-z0-9]/gi, '_')}`;
    const decision = `${contract.method} ${contract.path} expects ${contract.request}, returns ${contract.response}`;
    const reasoning = `Auto-extracted from ${contract.file}. Frontend/backend must use exact schema.`;

    return {
      type: 'decision',
      topic,
      decision,
      reasoning,
      confidence: contract.confidence,
    };
  }

  if (contract.type === 'function_signature') {
    const topic = `contract_function_${contract.name}`;
    const decision = `${contract.name}(${contract.params.join(', ')}) defined in ${contract.file}`;
    const reasoning = `Auto-extracted function signature. Callers must match exact signature.`;

    return {
      type: 'decision',
      topic,
      decision,
      reasoning,
      confidence: contract.confidence,
    };
  }

  if (contract.type === 'type_definition') {
    const topic = `contract_type_${contract.name}`;
    const decision = `${contract.kind} ${contract.name} { ${contract.fields.join('; ')} }`;
    const reasoning = `Auto-extracted type definition from ${contract.file}. All usages must match.`;

    return {
      type: 'decision',
      topic,
      decision,
      reasoning,
      confidence: contract.confidence,
    };
  }

  return null;
}

module.exports = {
  extractApiContracts,
  extractFunctionSignatures,
  extractTypeDefinitions,
  extractContracts,
  formatContractForMama,
};
