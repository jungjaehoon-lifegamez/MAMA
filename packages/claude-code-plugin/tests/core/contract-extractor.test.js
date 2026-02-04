/**
 * Contract Extractor Test
 * Tests for multi-language contract extraction (MAMA v2)
 *
 * Validates contract detection for:
 * - JavaScript/TypeScript (Express API, functions, types)
 * - Python (function definitions)
 * - Java (Spring annotations)
 * - SQL (CREATE TABLE, ALTER TABLE)
 * - GraphQL (type, input, interface)
 * - Go (functions)
 * - Rust (functions)
 */

import { describe, it, expect } from 'vitest';
import {
  extractApiContracts,
  extractFunctionSignatures,
  extractTypeDefinitions,
  extractSqlSchemas,
  extractGraphQLSchemas,
  extractGoSignatures,
  extractRustSignatures,
  extractContracts,
  formatContractForMama,
} from '../../src/core/contract-extractor.js';

describe('Contract Extractor - Multi-Language Support', () => {
  describe('extractApiContracts', () => {
    it('should extract Express API endpoints', () => {
      const code = `
        app.post('/api/auth/register', async (req, res) => {
          const { email, password } = req.body;
          res.json({ userId: user.id, token });
        });
      `;

      const contracts = extractApiContracts(code, 'test.js');

      expect(contracts).toHaveLength(1);
      expect(contracts[0].type).toBe('api_endpoint');
      expect(contracts[0].method).toBe('POST');
      expect(contracts[0].path).toBe('/api/auth/register');
      expect(contracts[0].confidence).toBeGreaterThan(0.5);
    });

    it('should extract Spring API endpoints', () => {
      const code = `
        @PostMapping("/api/users")
        public ResponseEntity<User> createUser(@RequestBody CreateUserRequest request) {
          // implementation
        }
      `;

      const contracts = extractApiContracts(code, 'UserController.java');

      expect(contracts).toHaveLength(1);
      expect(contracts[0].type).toBe('api_endpoint');
      expect(contracts[0].method).toBe('POST');
      expect(contracts[0].path).toBe('/api/users');
    });

    it('should extract multiple endpoints from the same file', () => {
      const code = `
        app.get('/api/users/:id', (req, res) => {});
        app.post('/api/users', (req, res) => {});
        app.delete('/api/users/:id', (req, res) => {});
      `;

      const contracts = extractApiContracts(code, 'routes.js');

      expect(contracts).toHaveLength(3);
      expect(contracts.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE']);
    });
  });

  describe('extractFunctionSignatures', () => {
    it('should extract JavaScript function declarations', () => {
      const code = `
        function createUser(email, password) {
          // implementation
        }
      `;

      const signatures = extractFunctionSignatures(code, 'user.js');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].type).toBe('function_signature');
      expect(signatures[0].name).toBe('createUser');
      expect(signatures[0].params).toEqual(['email', 'password']);
    });

    it('should extract Python function definitions', () => {
      const code = `
        async def create_user(email: str, password: str):
            # implementation
            pass
      `;

      const signatures = extractFunctionSignatures(code, 'user.py');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].name).toBe('create_user');
      expect(signatures[0].params).toEqual(['email: str', 'password: str']);
    });

    it('should extract arrow functions', () => {
      const code = `
        const validateEmail = (email) => {
          return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
        };
      `;

      const signatures = extractFunctionSignatures(code, 'validators.js');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].name).toBe('validateEmail');
      expect(signatures[0].params).toEqual(['email']);
    });
  });

  describe('extractTypeDefinitions', () => {
    it('should extract TypeScript interfaces', () => {
      const code = `
        interface User {
          id: string;
          email: string;
          name: string;
        }
      `;

      const types = extractTypeDefinitions(code, 'types.ts');

      expect(types).toHaveLength(1);
      expect(types[0].type).toBe('type_definition');
      expect(types[0].kind).toBe('interface');
      expect(types[0].name).toBe('User');
      expect(types[0].fields).toContain('id: string');
    });

    it('should extract TypeScript type aliases', () => {
      const code = `
        type LoginRequest = {
          email: string;
          password: string;
        };
      `;

      const types = extractTypeDefinitions(code, 'types.ts');

      expect(types).toHaveLength(1);
      expect(types[0].kind).toBe('type');
      expect(types[0].name).toBe('LoginRequest');
    });
  });

  describe('extractSqlSchemas', () => {
    it('should extract CREATE TABLE statements', () => {
      const code = `
        CREATE TABLE users (
          id INT PRIMARY KEY AUTO_INCREMENT,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;

      const schemas = extractSqlSchemas(code, 'schema.sql');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].type).toBe('sql_schema');
      expect(schemas[0].operation).toBe('CREATE_TABLE');
      expect(schemas[0].table).toBe('users');
      expect(schemas[0].columns.length).toBeGreaterThan(0);
      expect(schemas[0].columns.some((c) => c.includes('email'))).toBe(true);
    });

    it('should extract CREATE TABLE IF NOT EXISTS', () => {
      const code = `
        CREATE TABLE IF NOT EXISTS sessions (
          session_id VARCHAR(128) PRIMARY KEY,
          user_id INT NOT NULL
        );
      `;

      const schemas = extractSqlSchemas(code, 'schema.sql');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].table).toBe('sessions');
    });

    it('should extract ALTER TABLE statements', () => {
      const code = `
        ALTER TABLE users ADD COLUMN last_login TIMESTAMP;
      `;

      const schemas = extractSqlSchemas(code, 'migration.sql');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].operation).toBe('ALTER_TABLE');
      expect(schemas[0].table).toBe('users');
      expect(schemas[0].columns).toContain('last_login TIMESTAMP');
    });
  });

  describe('extractGraphQLSchemas', () => {
    it('should extract GraphQL type definitions', () => {
      const code = `
        type User {
          id: ID!
          email: String!
          name: String
          posts: [Post!]!
        }
      `;

      const schemas = extractGraphQLSchemas(code, 'schema.graphql');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].type).toBe('graphql_schema');
      expect(schemas[0].kind).toBe('type');
      expect(schemas[0].name).toBe('User');
      expect(schemas[0].fields.some((f) => f.includes('email'))).toBe(true);
    });

    it('should extract GraphQL input definitions', () => {
      const code = `
        input CreateUserInput {
          email: String!
          password: String!
          name: String
        }
      `;

      const schemas = extractGraphQLSchemas(code, 'schema.graphql');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].kind).toBe('input');
      expect(schemas[0].name).toBe('CreateUserInput');
    });

    it('should extract GraphQL interfaces', () => {
      const code = `
        interface Node {
          id: ID!
        }
      `;

      const schemas = extractGraphQLSchemas(code, 'schema.graphql');

      expect(schemas).toHaveLength(1);
      expect(schemas[0].kind).toBe('interface');
      expect(schemas[0].name).toBe('Node');
    });
  });

  describe('extractGoSignatures', () => {
    it('should extract Go function signatures', () => {
      const code = `
        func CreateUser(email string, password string) (*User, error) {
          // implementation
        }
      `;

      const signatures = extractGoSignatures(code, 'user.go');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].type).toBe('function_signature');
      expect(signatures[0].language).toBe('go');
      expect(signatures[0].name).toBe('CreateUser');
      expect(signatures[0].params).toEqual(['email string', 'password string']);
    });

    it('should extract Go method signatures with receivers', () => {
      const code = `
        func (s *Server) HandleLogin(w http.ResponseWriter, r *http.Request) {
          // implementation
        }
      `;

      const signatures = extractGoSignatures(code, 'server.go');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].name).toBe('HandleLogin');
    });
  });

  describe('extractRustSignatures', () => {
    it('should extract Rust function signatures', () => {
      const code = `
        fn create_user(email: String, password: String) -> Result<User, Error> {
          // implementation
        }
      `;

      const signatures = extractRustSignatures(code, 'user.rs');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].type).toBe('function_signature');
      expect(signatures[0].language).toBe('rust');
      expect(signatures[0].name).toBe('create_user');
    });

    it('should extract public async Rust functions', () => {
      const code = `
        pub async fn login(credentials: LoginCredentials) -> Result<Token> {
          // implementation
        }
      `;

      const signatures = extractRustSignatures(code, 'auth.rs');

      expect(signatures).toHaveLength(1);
      expect(signatures[0].name).toBe('login');
    });
  });

  describe('extractContracts (integration)', () => {
    it('should extract all contract types from multi-language codebase', () => {
      const code = `
        // TypeScript API
        app.post('/api/users', async (req, res) => {
          const user = await createUser(req.body);
          res.json(user);
        });

        // TypeScript function
        function createUser(data) {
          return db.users.create(data);
        }

        // TypeScript interface
        interface User {
          id: string;
          email: string;
        }
      `;

      const contracts = extractContracts(code, 'user-service.ts');

      expect(contracts.apiEndpoints).toHaveLength(1);
      expect(contracts.functionSignatures).toHaveLength(1);
      expect(contracts.typeDefinitions).toHaveLength(1);
    });
  });

  describe('formatContractForMama', () => {
    it('should format API contract for MAMA decision', () => {
      const contract = {
        type: 'api_endpoint',
        method: 'POST',
        path: '/api/auth/register',
        request: '{email, password}',
        response: '{userId, token}',
        file: 'auth.ts',
        confidence: 0.9,
      };

      const decision = formatContractForMama(contract);

      expect(decision.type).toBe('decision');
      expect(decision.topic).toBe('contract_post__api_auth_register');
      expect(decision.decision).toContain('POST /api/auth/register');
      expect(decision.reasoning).toContain('Frontend/backend must use exact schema');
      expect(decision.confidence).toBe(0.9);
    });

    it('should format function signature for MAMA decision', () => {
      const contract = {
        type: 'function_signature',
        name: 'createUser',
        params: ['email', 'password'],
        file: 'user.js',
        confidence: 0.8,
      };

      const decision = formatContractForMama(contract);

      expect(decision.topic).toBe('contract_function_createUser');
      expect(decision.decision).toContain('createUser(email, password)');
    });

    it('should format SQL schema for MAMA decision', () => {
      const contract = {
        type: 'sql_schema',
        operation: 'CREATE_TABLE',
        table: 'users',
        columns: ['id INT', 'email VARCHAR(255)'],
        file: 'schema.sql',
        confidence: 0.9,
      };

      const decision = formatContractForMama(contract);

      expect(decision.topic).toBe('contract_sql_users');
      expect(decision.decision).toContain('CREATE TABLE users');
      expect(decision.reasoning).toContain('Database operations must match exact schema');
    });

    it('should format GraphQL schema for MAMA decision', () => {
      const contract = {
        type: 'graphql_schema',
        kind: 'type',
        name: 'User',
        fields: ['id: ID!', 'email: String!'],
        file: 'schema.graphql',
        confidence: 0.9,
      };

      const decision = formatContractForMama(contract);

      expect(decision.topic).toBe('contract_graphql_User');
      expect(decision.decision).toContain('type User');
      expect(decision.reasoning).toContain('GraphQL queries/mutations must match schema');
    });
  });
});
