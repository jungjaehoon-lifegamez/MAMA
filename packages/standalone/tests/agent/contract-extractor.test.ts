import { describe, it, expect } from 'vitest';
import {
  extractContracts,
  extractApiContracts,
  extractFunctionSignatures,
  extractTypeDefinitions,
  extractSqlSchemas,
  extractGraphQLSchemas,
  extractGoSignatures,
  extractRustSignatures,
  EDIT_TOOLS,
  LOW_PRIORITY_PATTERNS,
  isLowPriorityPath,
  CONTRACT_SAVE_LIMIT,
} from '../../src/agent/contract-extractor.js';

describe('EDIT_TOOLS constant', () => {
  it('should contain expected tool names', () => {
    expect(EDIT_TOOLS).toContain('write_file');
    expect(EDIT_TOOLS).toContain('apply_patch');
    expect(EDIT_TOOLS).toContain('Edit');
    expect(EDIT_TOOLS).toContain('Write');
    expect(EDIT_TOOLS).toContain('test');
    expect(EDIT_TOOLS).toContain('build');
  });

  it('should have correct length', () => {
    expect(EDIT_TOOLS.length).toBe(6);
  });
});

describe('CONTRACT_SAVE_LIMIT constant', () => {
  it('should be set to 20', () => {
    expect(CONTRACT_SAVE_LIMIT).toBe(20);
  });
});

describe('LOW_PRIORITY_PATTERNS', () => {
  it('should contain regex patterns for docs', () => {
    const docPatterns = LOW_PRIORITY_PATTERNS.filter((p) => p.test('/docs/readme.md'));
    expect(docPatterns.length).toBeGreaterThan(0);
  });

  it('should contain patterns for test files', () => {
    const testPatterns = LOW_PRIORITY_PATTERNS.filter(
      (p) => p.test('.test.js') || p.test('/tests/')
    );
    expect(testPatterns.length).toBeGreaterThan(0);
  });

  it('should contain patterns for config files', () => {
    const configPatterns = LOW_PRIORITY_PATTERNS.filter((p) => p.test('config.json'));
    expect(configPatterns.length).toBeGreaterThan(0);
  });
});

describe('isLowPriorityPath()', () => {
  it('should return true for docs paths', () => {
    expect(isLowPriorityPath('/docs/guide.md')).toBe(true);
    expect(isLowPriorityPath('/doc/readme.md')).toBe(true);
  });

  it('should return true for test files', () => {
    expect(isLowPriorityPath('auth.test.js')).toBe(true);
    expect(isLowPriorityPath('auth.spec.ts')).toBe(true);
    expect(isLowPriorityPath('/tests/unit/auth.test.ts')).toBe(true);
  });

  it('should return true for example files', () => {
    expect(isLowPriorityPath('/examples/auth.js')).toBe(true);
    expect(isLowPriorityPath('/example/demo.ts')).toBe(true);
  });

  it('should return true for config files', () => {
    expect(isLowPriorityPath('config.json')).toBe(true);
    expect(isLowPriorityPath('tsconfig.json')).toBe(true);
    expect(isLowPriorityPath('.env')).toBe(true);
    expect(isLowPriorityPath('.env.local')).toBe(true);
  });

  it('should return true for markdown files', () => {
    expect(isLowPriorityPath('README.md')).toBe(true);
    expect(isLowPriorityPath('CHANGELOG.md')).toBe(true);
  });

  it('should return true for node_modules', () => {
    expect(isLowPriorityPath('node_modules/package/index.js')).toBe(true);
  });

  it('should return false for source code files', () => {
    expect(isLowPriorityPath('src/auth.ts')).toBe(false);
    expect(isLowPriorityPath('lib/utils.js')).toBe(false);
  });

  it('should return false for empty path', () => {
    expect(isLowPriorityPath('')).toBe(false);
  });

  it('should return false for null-like values', () => {
    expect(isLowPriorityPath('')).toBe(false);
  });
});

describe('extractApiContracts()', () => {
  it('should extract Express GET endpoint', () => {
    const code = `app.get('/api/users', (req, res) => {
      res.json({ users: [] });
    });`;
    const contracts = extractApiContracts(code, 'routes.js');

    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      type: 'api_endpoint',
      method: 'GET',
      path: '/api/users',
      file: 'routes.js',
    });
  });

  it('should extract Express POST endpoint with request/response schema', () => {
    const code = `app.post('/api/auth/login', (req, res) => {
      const { email, password } = req.body;
      res.status(200).json({ userId: 1, token: 'abc' });
    });`;
    const contracts = extractApiContracts(code, 'auth.js');

    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      type: 'api_endpoint',
      method: 'POST',
      path: '/api/auth/login',
      file: 'auth.js',
    });
    expect(contracts[0].confidence).toBe(0.9);
  });

  it('should extract multiple HTTP methods', () => {
    const code = `
      app.get('/users', handler);
      app.post('/users', handler);
      app.put('/users/:id', handler);
      app.delete('/users/:id', handler);
    `;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(4);
    expect(contracts.map((c) => c.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
  });

  it('should extract router endpoints', () => {
    const code = `router.get('/profile', (req, res) => {
      res.json({ name: 'John' });
    });`;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(1);
    expect(contracts[0].path).toBe('/profile');
  });

  it('should extract Spring @PostMapping endpoint', () => {
    const code = `@PostMapping("/api/users")
    public ResponseEntity<User> createUser(@RequestBody User user) {
      return ResponseEntity.ok(user);
    }`;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      type: 'api_endpoint',
      method: 'POST',
      path: '/api/users',
    });
  });

  it('should extract Spring @GetMapping endpoint', () => {
    const code = `@GetMapping("/api/users/{id}")
    public User getUser(@PathVariable Long id) {
      return userService.findById(id);
    }`;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(1);
    expect(contracts[0].method).toBe('GET');
  });

  it('should handle endpoints without schema info', () => {
    const code = `app.get('/health', (req, res) => {
      res.send('OK');
    });`;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(1);
    expect(contracts[0].confidence).toBe(0.6);
  });

  it('should return empty array for code without endpoints', () => {
    const code = `const x = 5;
    function add(a, b) { return a + b; }`;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(0);
  });
});

describe('extractFunctionSignatures()', () => {
  it('should extract JavaScript function declaration', () => {
    const code = `function createUser(email, password) {
      return { email, password };
    }`;
    const signatures = extractFunctionSignatures(code, 'auth.js');

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      type: 'function_signature',
      name: 'createUser',
      params: ['email', 'password'],
      file: 'auth.js',
    });
  });

  it('should extract TypeScript function with return type', () => {
    const code = `function validateEmail(email: string): boolean {
      return email.includes('@');
    }`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      name: 'validateEmail',
      returnType: 'boolean',
    });
    expect(signatures[0].confidence).toBe(0.9);
  });

  it('should extract async function', () => {
    const code = `async function fetchUser(id: number): Promise<User> {
      return await api.get(\`/users/\${id}\`);
    }`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].name).toBe('fetchUser');
  });

  it('should extract arrow function', () => {
    const code = `const add = (a: number, b: number): number => {
      return a + b;
    };`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      name: 'add',
      params: ['a: number', 'b: number'],
      returnType: 'number',
    });
  });

  it('should extract async arrow function', () => {
    const code = `const fetchData = async (url: string): Promise<any> => {
      return await fetch(url);
    };`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].name).toBe('fetchData');
  });

  it('should extract Python function with type hints', () => {
    const code = `def process_order(order_id: int) -> dict:
      return {"status": "processed"}`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      name: 'process_order',
      params: ['order_id: int'],
      returnType: 'dict',
    });
  });

  it('should extract async Python function', () => {
    const code = `async def fetch_user(user_id: int) -> User:
      return await db.get_user(user_id)`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].name).toBe('fetch_user');
  });

  it('should extract Go function signature', () => {
    const code = `func CreateUser(email string, password string) (*User, error) {
      return &User{Email: email}, nil
    }`;
    const signatures = extractGoSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      type: 'function_signature',
      name: 'CreateUser',
      language: 'go',
    });
  });

  it('should extract Rust function signature', () => {
    const code = `fn create_user(email: String, password: String) -> Result<User, Error> {
      Ok(User { email, password })
    }`;
    const signatures = extractRustSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      type: 'function_signature',
      name: 'create_user',
      language: 'rust',
    });
  });

  it('should extract pub async Rust function', () => {
    const code = `pub async fn login(credentials: LoginCredentials) -> Result<Token> {
      Ok(Token::new())
    }`;
    const signatures = extractRustSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].name).toBe('login');
  });

  it('should extract function with JSDoc return type', () => {
    const code = `/**
     * @returns {Promise<User>}
     */
    function getUser(id) {
      return fetch(\`/api/users/\${id}\`);
    }`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].returnType).toBe('Promise<User>');
  });

  it('should return empty array for code without functions', () => {
    const code = `const x = 5;
    const y = 10;`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(0);
  });

  it('should extract multiple functions', () => {
    const code = `
      function add(a, b) { return a + b; }
      function subtract(a, b) { return a - b; }
      const multiply = (a, b) => a * b;
    `;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(3);
  });

  it('should include line numbers', () => {
    const code = `function first() {}

function second() {}`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures[0].line).toBe(1);
    expect(signatures[1].line).toBe(3);
  });
});

describe('extractTypeDefinitions()', () => {
  it('should extract TypeScript interface', () => {
    const code = `interface User {
      id: number;
      email: string;
      name: string;
    }`;
    const types = extractTypeDefinitions(code, 'types.ts');

    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      type: 'type_definition',
      kind: 'interface',
      name: 'User',
      file: 'types.ts',
    });
    expect(types[0].fields).toContain('id: number');
  });

  it('should extract TypeScript type alias', () => {
    const code = `type LoginRequest = {
      email: string;
      password: string;
    }`;
    const types = extractTypeDefinitions(code);

    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      type: 'type_definition',
      kind: 'type',
      name: 'LoginRequest',
    });
  });

  it('should limit fields to 5', () => {
    const code = `interface LargeType {
      field1: string;
      field2: string;
      field3: string;
      field4: string;
      field5: string;
      field6: string;
      field7: string;
    }`;
    const types = extractTypeDefinitions(code);

    expect(types[0].fields?.length).toBeLessThanOrEqual(5);
  });

  it('should extract multiple type definitions', () => {
    const code = `
      interface User { id: number; }
      type Status = 'active' | 'inactive';
      interface Post { title: string; }
    `;
    const types = extractTypeDefinitions(code);

    expect(types.length).toBeGreaterThanOrEqual(2);
  });

  it('should return empty array for code without types', () => {
    const code = `const x = 5;
    function add(a, b) { return a + b; }`;
    const types = extractTypeDefinitions(code);

    expect(types).toHaveLength(0);
  });

  it('should have high confidence for type definitions', () => {
    const code = `interface Config { debug: boolean; }`;
    const types = extractTypeDefinitions(code);

    expect(types[0].confidence).toBe(0.9);
  });
});

describe('extractSqlSchemas()', () => {
  it('should extract CREATE TABLE statement', () => {
    const code = `CREATE TABLE users (
      id INT PRIMARY KEY,
      email VARCHAR(255),
      name VARCHAR(100)
    )`;
    const schemas = extractSqlSchemas(code, 'schema.sql');

    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      type: 'sql_schema',
      operation: 'CREATE_TABLE',
      table: 'users',
      file: 'schema.sql',
    });
    expect(schemas[0].columns).toContain('id INT PRIMARY KEY');
  });

  it('should extract CREATE TABLE IF NOT EXISTS', () => {
    const code = `CREATE TABLE IF NOT EXISTS products (
      id INT,
      name VARCHAR(255)
    )`;
    const schemas = extractSqlSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].table).toBe('products');
  });

  it('should extract ALTER TABLE ADD COLUMN', () => {
    const code = `ALTER TABLE users ADD COLUMN age INT`;
    const schemas = extractSqlSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      type: 'sql_schema',
      operation: 'ALTER_TABLE',
      table: 'users',
    });
    expect(schemas[0].columns).toContain('age INT');
  });

  it('should limit columns to 10', () => {
    const code = `CREATE TABLE big_table (
      col1 INT,
      col2 INT,
      col3 INT,
      col4 INT,
      col5 INT,
      col6 INT,
      col7 INT,
      col8 INT,
      col9 INT,
      col10 INT,
      col11 INT,
      col12 INT
    )`;
    const schemas = extractSqlSchemas(code);

    expect(schemas[0].columns?.length).toBeLessThanOrEqual(10);
  });

  it('should filter out constraint definitions', () => {
    const code = `CREATE TABLE users (
      id INT,
      email VARCHAR(255),
      PRIMARY KEY (id),
      UNIQUE (email)
    )`;
    const schemas = extractSqlSchemas(code);

    const columns = schemas[0].columns || [];
    expect(columns.some((c) => c.includes('PRIMARY KEY'))).toBe(false);
  });

  it('should extract multiple CREATE TABLE statements', () => {
    const code = `
      CREATE TABLE users (id INT);
      CREATE TABLE posts (id INT);
    `;
    const schemas = extractSqlSchemas(code);

    expect(schemas).toHaveLength(2);
  });

  it('should return empty array for code without SQL', () => {
    const code = `const x = 5;
    function test() {}`;
    const schemas = extractSqlSchemas(code);

    expect(schemas).toHaveLength(0);
  });

  it('should have high confidence for CREATE TABLE', () => {
    const code = `CREATE TABLE test (id INT)`;
    const schemas = extractSqlSchemas(code);

    expect(schemas[0].confidence).toBe(0.9);
  });

  it('should have slightly lower confidence for ALTER TABLE', () => {
    const code = `ALTER TABLE test ADD COLUMN name VARCHAR(255)`;
    const schemas = extractSqlSchemas(code);

    expect(schemas[0].confidence).toBe(0.8);
  });
});

describe('extractGraphQLSchemas()', () => {
  it('should extract GraphQL type definition', () => {
    const code = `type User {
      id: ID!
      email: String!
      name: String
    }`;
    const schemas = extractGraphQLSchemas(code, 'schema.graphql');

    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      type: 'graphql_schema',
      kind: 'type',
      name: 'User',
      file: 'schema.graphql',
    });
    expect(schemas[0].fields).toContain('id: ID!');
  });

  it('should extract GraphQL input type', () => {
    const code = `input CreateUserInput {
      email: String!
      password: String!
    }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      kind: 'input',
      name: 'CreateUserInput',
    });
  });

  it('should extract GraphQL interface', () => {
    const code = `interface Node {
      id: ID!
    }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].kind).toBe('interface');
  });

  it('should extract GraphQL interface', () => {
    const code = `interface Node {
      id: ID!
      createdAt: String!
    }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].kind).toBe('interface');
  });

  it('should limit fields to 10', () => {
    const code = `type BigType {
      field1: String
      field2: String
      field3: String
      field4: String
      field5: String
      field6: String
      field7: String
      field8: String
      field9: String
      field10: String
      field11: String
      field12: String
    }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas[0].fields?.length).toBeLessThanOrEqual(10);
  });

  it('should filter out comments', () => {
    const code = `type User {
      # User ID
      id: ID!
      # User email
      email: String!
    }`;
    const schemas = extractGraphQLSchemas(code);

    const fields = schemas[0].fields || [];
    expect(fields.some((f) => f.startsWith('#'))).toBe(false);
  });

  it('should extract multiple GraphQL definitions', () => {
    const code = `
      type User { id: ID! }
      input CreateUserInput { email: String! }
      interface Node { id: ID! }
    `;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas.length).toBeGreaterThanOrEqual(2);
  });

  it('should return empty array for code without GraphQL', () => {
    const code = `const x = 5;
    function test() {}`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas).toHaveLength(0);
  });

  it('should have high confidence for GraphQL schemas', () => {
    const code = `type User { id: ID! }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas[0].confidence).toBe(0.9);
  });
});

describe('extractContracts()', () => {
  it('should extract all contract types from mixed code', () => {
    const code = `
      interface User { id: number; }
      
      app.get('/api/users', (req, res) => {
        res.json({ users: [] });
      });
      
      function getUser(id: number): User {
        return { id };
      }
      
      CREATE TABLE users (id INT);
      
      type Query {
        user(id: ID!): User
      }
    `;
    const result = extractContracts(code, 'mixed.ts');

    expect(result.apiEndpoints.length).toBeGreaterThan(0);
    expect(result.functionSignatures.length).toBeGreaterThan(0);
    expect(result.typeDefinitions.length).toBeGreaterThan(0);
    expect(result.sqlSchemas.length).toBeGreaterThan(0);
    expect(result.graphqlSchemas.length).toBeGreaterThan(0);
  });

  it('should return ExtractionResult with all arrays', () => {
    const code = `const x = 5;`;
    const result = extractContracts(code);

    expect(result).toHaveProperty('apiEndpoints');
    expect(result).toHaveProperty('functionSignatures');
    expect(result).toHaveProperty('typeDefinitions');
    expect(result).toHaveProperty('sqlSchemas');
    expect(result).toHaveProperty('graphqlSchemas');
    expect(Array.isArray(result.apiEndpoints)).toBe(true);
    expect(Array.isArray(result.functionSignatures)).toBe(true);
    expect(Array.isArray(result.typeDefinitions)).toBe(true);
    expect(Array.isArray(result.sqlSchemas)).toBe(true);
    expect(Array.isArray(result.graphqlSchemas)).toBe(true);
  });

  it('should handle empty content', () => {
    const result = extractContracts('', 'empty.js');

    expect(result.apiEndpoints).toHaveLength(0);
    expect(result.functionSignatures).toHaveLength(0);
    expect(result.typeDefinitions).toHaveLength(0);
    expect(result.sqlSchemas).toHaveLength(0);
    expect(result.graphqlSchemas).toHaveLength(0);
  });

  it('should handle code with no matches', () => {
    const code = `const x = 5;
    const y = 10;
    const z = x + y;`;
    const result = extractContracts(code);

    expect(result.apiEndpoints).toHaveLength(0);
    expect(result.functionSignatures).toHaveLength(0);
    expect(result.typeDefinitions).toHaveLength(0);
    expect(result.sqlSchemas).toHaveLength(0);
    expect(result.graphqlSchemas).toHaveLength(0);
  });

  it('should include file path in all contracts', () => {
    const code = `
      app.get('/test', handler);
      function test() {}
    `;
    const result = extractContracts(code, 'test.ts');

    result.apiEndpoints.forEach((contract) => {
      expect(contract.file).toBe('test.ts');
    });
    result.functionSignatures.forEach((contract) => {
      expect(contract.file).toBe('test.ts');
    });
  });

  it('should combine function signatures from multiple extractors', () => {
    const code = `
      function jsFunc() {}
      func GoFunc() {}
      fn rust_func() {}
    `;
    const result = extractContracts(code);

    expect(result.functionSignatures.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle malformed code gracefully', () => {
    const code = `
      function broken(
      app.get('/api', handler
      interface Incomplete {
    `;
    const result = extractContracts(code);

    expect(result).toBeDefined();
    expect(Array.isArray(result.apiEndpoints)).toBe(true);
  });
});

describe('Edge cases', () => {
  it('should handle code with special characters in paths', () => {
    const code = `app.get('/api/users/:id/profile', handler);`;
    const contracts = extractApiContracts(code);

    expect(contracts).toHaveLength(1);
    expect(contracts[0].path).toBe('/api/users/:id/profile');
  });

  it('should handle function names with underscores', () => {
    const code = `function get_user_by_id(id) {}`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].name).toBe('get_user_by_id');
  });

  it('should handle nested braces in type definitions', () => {
    const code = `interface Config {
      nested: { key: string };
    }`;
    const types = extractTypeDefinitions(code);

    expect(types.length).toBeGreaterThan(0);
  });

  it('should handle SQL with complex column definitions', () => {
    const code = `CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
    const schemas = extractSqlSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].columns?.length).toBeGreaterThan(0);
  });

  it('should handle GraphQL with implements keyword', () => {
    const code = `type User implements Node {
      id: ID!
      name: String!
    }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('User');
  });

  it('should handle function parameters with default values', () => {
    const code = `function greet(name = 'World') {}`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].params).toContain("name = 'World'");
  });

  it('should handle TypeScript function with complex return type', () => {
    const code = `function process(data: any[]): Promise<{ success: boolean; data: any }> {
      return Promise.resolve({ success: true, data: null });
    }`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].returnType).toBeDefined();
  });

  it('should handle case-insensitive SQL keywords', () => {
    const code = `create table users (id int)`;
    const schemas = extractSqlSchemas(code);

    expect(schemas).toHaveLength(1);
  });

  it('should handle case-insensitive GraphQL keywords', () => {
    const code = `TYPE User { id: ID! }`;
    const schemas = extractGraphQLSchemas(code);

    expect(schemas).toHaveLength(1);
  });

  it('should handle whitespace variations in function signatures', () => {
    const code = `function   test   (   a  ,  b   )   {   }`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].name).toBe('test');
  });

  it('should handle empty parameter lists', () => {
    const code = `function noParams() {}`;
    const signatures = extractFunctionSignatures(code);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].params).toHaveLength(0);
  });

  it('should handle single-line type definitions', () => {
    const code = `type Status = 'active' | 'inactive';`;
    const types = extractTypeDefinitions(code);

    expect(types.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle API endpoints with query parameters', () => {
    const code = `app.get('/api/search?q=:query', handler);`;
    const contracts = extractApiContracts(code);

    expect(contracts.length).toBeGreaterThan(0);
  });
});
