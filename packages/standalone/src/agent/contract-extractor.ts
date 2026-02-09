/**
 * Contract Extractor for MAMA v2 (TypeScript Port)
 *
 * Extracts API contracts, function signatures, and type definitions
 * from code changes using simple pattern matching.
 *
 * Design Philosophy:
 * - Simple regex patterns for common cases (80% coverage)
 * - Main Claude handles complex cases (20%)
 * - Transparent: All extractions visible to Main Claude
 *
 * Ported from: packages/claude-code-plugin/src/core/contract-extractor.js
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ExtractedContract {
  type: 'api_endpoint' | 'function_signature' | 'type_definition' | 'sql_schema' | 'graphql_schema';
  confidence: number;
  file: string;

  // api_endpoint fields
  method?: string;
  path?: string;
  request?: string;
  response?: string;
  snippet?: string;

  // function_signature fields
  name?: string;
  params?: string[];
  returnType?: string;
  line?: number;
  language?: string;

  // type_definition fields
  kind?: string;
  fields?: string[];

  // sql_schema fields
  operation?: string;
  table?: string;
  columns?: string[];
}

export interface ExtractionResult {
  apiEndpoints: ExtractedContract[];
  functionSignatures: ExtractedContract[];
  typeDefinitions: ExtractedContract[];
  sqlSchemas: ExtractedContract[];
  graphqlSchemas: ExtractedContract[];
}

export interface MamaDecisionFormat {
  type: 'decision';
  topic: string;
  decision: string;
  reasoning: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools that trigger auto-save consideration */
export const EDIT_TOOLS: readonly string[] = [
  'write_file',
  'apply_patch',
  'Edit',
  'Write',
  'test',
  'build',
];

/** Maximum number of contracts to save per extraction */
export const CONTRACT_SAVE_LIMIT = 20;

/** Similarity threshold for auto-save suggestion */
export const SIMILARITY_THRESHOLD = 0.75;

/** Files/paths that don't need contract tracking */
export const LOW_PRIORITY_PATTERNS: readonly RegExp[] = [
  /\/docs?\//i, // docs/ or doc/
  /\/examples?\//i, // examples/ or example/
  /\/demo\//i, // demo/
  /\/stories\//i, // storybook stories
  /\/storybook\//i, // storybook config
  /\/test[s]?\//i, // test/ or tests/
  /\.test\.[jt]sx?$/i, // .test.js, .test.ts, etc.
  /\.spec\.[jt]sx?$/i, // .spec.js, .spec.ts, etc.
  /node_modules\//i, // dependencies
  /\.md$/i, // markdown docs
  /\.txt$/i, // text files
  /\.ya?ml$/i, // YAML config
  /\.json$/i, // JSON config
  /\.toml$/i, // TOML config
  /\.gitignore$/i, // git ignore
  /\.env/i, // environment files
  /LICENSE/i, // license files
  /README/i, // readme files
  /CHANGELOG/i, // changelog files
  /\.lock$/i, // lock files
  /\.log$/i, // log files
];

// ---------------------------------------------------------------------------
// Utility: isLowPriorityPath
// ---------------------------------------------------------------------------

/**
 * Check if a file path matches low-priority patterns (docs, tests, config, etc.)
 */
export function isLowPriorityPath(filePath: string): boolean {
  if (!filePath) {
    return false;
  }

  for (const pattern of LOW_PRIORITY_PATTERNS) {
    if (pattern.test(filePath)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract return type from JSDoc comment.
 * Looks for @returns {Type} or @return {Type}
 */
function extractJsDocReturnType(code: string, funcIndex: number): string | null {
  // Look back up to 500 chars for JSDoc comment before function
  const lookbackStart = Math.max(0, funcIndex - 500);
  const beforeFunc = code.substring(lookbackStart, funcIndex);

  // Find the closest JSDoc comment
  const jsDocMatch = beforeFunc.match(/\/\*\*[\s\S]*?\*\/\s*$/);
  if (!jsDocMatch) {
    return null;
  }

  const jsDoc = jsDocMatch[0];
  // Match @returns {Type} or @return {Type}
  const returnMatch = jsDoc.match(/@returns?\s*\{([^}]+)\}/i);
  if (returnMatch) {
    return returnMatch[1].trim();
  }

  return null;
}

/**
 * Calculate line number from string index
 */
function getLineNumber(code: string, index: number): number {
  const upToIndex = code.substring(0, index);
  return (upToIndex.match(/\n/g) || []).length + 1;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract API endpoint contracts from code
 *
 * Detects patterns like:
 * - app.post('/api/auth/register', ...)
 * - router.get('/users/:id', ...)
 * - @PostMapping("/api/users")
 */
export function extractApiContracts(code: string, filePath = ''): ExtractedContract[] {
  const contracts: ExtractedContract[] = [];

  // Express/Koa style: app.METHOD('/path', ...)
  const expressPattern =
    /(?:app|router)\.(get|post|put|patch|delete|options)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;

  while ((match = expressPattern.exec(code)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];

    // Extract wider context for Claude to analyze
    const contextStart = Math.max(0, match.index - 100);
    const contextEnd = Math.min(code.length, match.index + 1000);
    const contextCode = code.substring(contextStart, contextEnd);

    // Try to extract request schema from destructuring pattern
    // Pattern: const { x, y } = req.body
    const destructuringMatch = contextCode.match(/const\s*{\s*([^}]+)\s*}\s*=\s*req\.body/);

    // Try to extract response schema
    const responseMatch = contextCode.match(/res\.(?:status\(\d+\)\.)?json\s*\(\s*{([^}]+)}/);

    const requestSchema = destructuringMatch ? destructuringMatch[1].trim() : 'unknown';
    const responseSchema = responseMatch ? responseMatch[1].trim() : 'unknown';

    contracts.push({
      type: 'api_endpoint',
      method,
      path,
      request: requestSchema !== 'unknown' ? `{${requestSchema}}` : 'unknown',
      response: responseSchema !== 'unknown' ? `{${responseSchema}}` : 'unknown',
      snippet: contextCode.trim(), // Include code snippet for Claude analysis
      file: filePath,
      confidence: requestSchema !== 'unknown' && responseSchema !== 'unknown' ? 0.9 : 0.6,
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
 */
export function extractFunctionSignatures(code: string, filePath = ''): ExtractedContract[] {
  const signatures: ExtractedContract[] = [];

  // JavaScript/TypeScript function declarations (including TS return types)
  // Match: function name(params): ReturnType or function name(params)
  const jsFuncPattern = /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/gi;
  let match: RegExpExecArray | null;

  while ((match = jsFuncPattern.exec(code)) !== null) {
    const name = match[1];
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    // Get return type from TS annotation or JSDoc
    let returnType = match[3] ? match[3].trim() : null;
    if (!returnType) {
      returnType = extractJsDocReturnType(code, match.index);
    }

    const line = getLineNumber(code, match.index);

    signatures.push({
      type: 'function_signature',
      name,
      params,
      returnType: returnType || 'unknown',
      line,
      file: filePath,
      confidence: returnType ? 0.9 : 0.7,
    });
  }

  // Arrow functions (including TS return types)
  // Match: const name = (params): ReturnType => or const name = (params) =>
  const arrowPattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)(?:\s*:\s*([^=]+))?\s*=>/gi;

  while ((match = arrowPattern.exec(code)) !== null) {
    const name = match[1];
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    // Get return type from TS annotation or JSDoc
    let returnType = match[3] ? match[3].trim() : null;
    if (!returnType) {
      returnType = extractJsDocReturnType(code, match.index);
    }

    const line = getLineNumber(code, match.index);

    signatures.push({
      type: 'function_signature',
      name,
      params,
      returnType: returnType || 'unknown',
      line,
      file: filePath,
      confidence: returnType ? 0.9 : 0.7,
    });
  }

  // Python function definitions (with type hints)
  // Match: def name(params) -> ReturnType: or def name(params):
  const pyFuncPattern = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/gi;

  while ((match = pyFuncPattern.exec(code)) !== null) {
    const name = match[1];
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p);

    const returnType = match[3] ? match[3].trim() : null;
    const line = getLineNumber(code, match.index);

    signatures.push({
      type: 'function_signature',
      name,
      params,
      returnType: returnType || 'unknown',
      line,
      file: filePath,
      confidence: returnType ? 0.9 : 0.7,
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
 */
export function extractTypeDefinitions(code: string, filePath = ''): ExtractedContract[] {
  const types: ExtractedContract[] = [];

  // TypeScript interfaces
  const interfacePattern = /interface\s+(\w+)\s*{([^}]+)}/gi;
  let match: RegExpExecArray | null;

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
 */
export function extractSqlSchemas(code: string, filePath = ''): ExtractedContract[] {
  const schemas: ExtractedContract[] = [];

  // CREATE TABLE pattern
  const createTablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;

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
 */
export function extractGraphQLSchemas(code: string, filePath = ''): ExtractedContract[] {
  const schemas: ExtractedContract[] = [];

  // GraphQL type definitions
  const typePattern = /(type|input|interface)\s+(\w+)\s*(?:implements\s+\w+\s*)?{([^}]+)}/gi;
  let match: RegExpExecArray | null;

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
 */
export function extractGoSignatures(code: string, filePath = ''): ExtractedContract[] {
  const signatures: ExtractedContract[] = [];

  // Go function pattern (including receiver methods)
  const goFuncPattern =
    /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/gi;
  let match: RegExpExecArray | null;

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
 */
export function extractRustSignatures(code: string, filePath = ''): ExtractedContract[] {
  const signatures: ExtractedContract[] = [];

  // Rust function pattern
  const rustFuncPattern = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;

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

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Extract all contracts from code
 */
export function extractContracts(code: string, filePath = ''): ExtractionResult {
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

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format contract for MAMA decision
 */
export function formatContractForMama(contract: ExtractedContract): MamaDecisionFormat | null {
  if (contract.type === 'api_endpoint') {
    const topic = `contract_${(contract.method || '').toLowerCase()}_${(contract.path || '').replace(/[^a-z0-9]/gi, '_')}`;
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
    const decision = `${contract.name}(${(contract.params || []).join(', ')}) defined in ${contract.file}`;
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
    const decision = `${contract.kind} ${contract.name} { ${(contract.fields || []).join('; ')} }`;
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
    const decision = `${operation} ${contract.table} (${(contract.columns || []).join(', ')})`;
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
    const decision = `${contract.kind} ${contract.name} { ${(contract.fields || []).join(', ')} }`;
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
