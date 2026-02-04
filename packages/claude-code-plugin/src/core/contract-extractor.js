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

    // Try to extract request/response schema (scope to this endpoint's code block)
    // Look for req.body and res.json near this match position
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(code.length, match.index + 500);
    const contextCode = code.substring(contextStart, contextEnd);

    const bodyMatch = contextCode.match(/req\.body\s*[=:]\s*{([^}]+)}/);
    const responseMatch = contextCode.match(/res\.json\s*\(\s*{([^}]+)}/);

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
 * Extract SQL schemas from code
 *
 * Detects patterns like:
 * - CREATE TABLE users (id INT, email VARCHAR(255), ...)
 * - ALTER TABLE users ADD COLUMN name VARCHAR(255)
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted SQL schemas
 */
function extractSqlSchemas(code, filePath = '') {
  const schemas = [];

  // CREATE TABLE pattern
  const createTablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^)]+)\)/gi;
  let match;

  while ((match = createTablePattern.exec(code)) !== null) {
    const tableName = match[1];
    const columnsText = match[2];
    const columns = columnsText
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c && !c.match(/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)/i))
      .slice(0, 10); // Limit to 10 columns for brevity

    schemas.push({
      type: 'sql_schema',
      operation: 'CREATE_TABLE',
      table: tableName,
      columns,
      file: filePath,
      confidence: 0.9,
    });
  }

  // ALTER TABLE ADD COLUMN pattern
  const alterTablePattern =
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+\s+[A-Z]+(?:\([^)]+\))?)/gi;

  while ((match = alterTablePattern.exec(code)) !== null) {
    const tableName = match[1];
    const columnDef = match[2].trim();

    schemas.push({
      type: 'sql_schema',
      operation: 'ALTER_TABLE',
      table: tableName,
      columns: [columnDef],
      file: filePath,
      confidence: 0.8,
    });
  }

  return schemas;
}

/**
 * Extract GraphQL schemas from code
 *
 * Detects patterns like:
 * - type User { id: ID!, email: String!, ... }
 * - input CreateUserInput { email: String!, password: String! }
 * - interface Node { id: ID! }
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted GraphQL schemas
 */
function extractGraphQLSchemas(code, filePath = '') {
  const schemas = [];

  // GraphQL type definitions
  const typePattern = /(type|input|interface)\s+(\w+)\s*(?:implements\s+\w+\s*)?{([^}]+)}/gi;
  let match;

  while ((match = typePattern.exec(code)) !== null) {
    const kind = match[1];
    const name = match[2];
    const fieldsText = match[3];
    const fields = fieldsText
      .split(/\n/)
      .map((f) => f.trim())
      .filter((f) => f && !f.startsWith('#'))
      .slice(0, 10); // Limit to 10 fields

    schemas.push({
      type: 'graphql_schema',
      kind,
      name,
      fields,
      file: filePath,
      confidence: 0.9,
    });
  }

  return schemas;
}

/**
 * Extract Go function signatures from code
 *
 * Detects patterns like:
 * - func CreateUser(email string, password string) (*User, error)
 * - func (s *Server) HandleLogin(w http.ResponseWriter, r *http.Request)
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted Go function signatures
 */
function extractGoSignatures(code, filePath = '') {
  const signatures = [];

  // Go function pattern (including receiver methods)
  const goFuncPattern =
    /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/gi;
  let match;

  while ((match = goFuncPattern.exec(code)) !== null) {
    const name = match[1];
    const paramsText = match[2];
    const params = paramsText
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    signatures.push({
      type: 'function_signature',
      language: 'go',
      name,
      params,
      file: filePath,
      confidence: 0.8,
    });
  }

  return signatures;
}

/**
 * Extract Rust function signatures from code
 *
 * Detects patterns like:
 * - fn create_user(email: String, password: String) -> Result<User, Error>
 * - pub async fn login(credentials: LoginCredentials) -> Result<Token>
 *
 * @param {string} code - Code snippet to analyze
 * @param {string} filePath - File path for context
 * @returns {Array<Object>} Extracted Rust function signatures
 */
function extractRustSignatures(code, filePath = '') {
  const signatures = [];

  // Rust function pattern
  const rustFuncPattern = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/gi;
  let match;

  while ((match = rustFuncPattern.exec(code)) !== null) {
    const name = match[1];
    const paramsText = match[2];
    const params = paramsText
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    signatures.push({
      type: 'function_signature',
      language: 'rust',
      name,
      params,
      file: filePath,
      confidence: 0.8,
    });
  }

  return signatures;
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
    functionSignatures: [
      ...extractFunctionSignatures(code, filePath),
      ...extractGoSignatures(code, filePath),
      ...extractRustSignatures(code, filePath),
    ],
    typeDefinitions: extractTypeDefinitions(code, filePath),
    sqlSchemas: extractSqlSchemas(code, filePath),
    graphqlSchemas: extractGraphQLSchemas(code, filePath),
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

  if (contract.type === 'sql_schema') {
    const topic = `contract_sql_${contract.table}`;
    const operation = contract.operation === 'CREATE_TABLE' ? 'CREATE TABLE' : 'ALTER TABLE';
    const decision = `${operation} ${contract.table} (${contract.columns.join(', ')})`;
    const reasoning = `Auto-extracted SQL schema from ${contract.file}. Database operations must match exact schema.`;

    return {
      type: 'decision',
      topic,
      decision,
      reasoning,
      confidence: contract.confidence,
    };
  }

  if (contract.type === 'graphql_schema') {
    const topic = `contract_graphql_${contract.name}`;
    const decision = `${contract.kind} ${contract.name} { ${contract.fields.join(', ')} }`;
    const reasoning = `Auto-extracted GraphQL schema from ${contract.file}. GraphQL queries/mutations must match schema.`;

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
  extractSqlSchemas,
  extractGraphQLSchemas,
  extractGoSignatures,
  extractRustSignatures,
  extractContracts,
  formatContractForMama,
};
