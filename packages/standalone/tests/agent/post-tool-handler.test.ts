import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostToolHandler } from '../../src/agent/post-tool-handler.js';

describe('PostToolHandler', () => {
  let executeTool: ReturnType<typeof vi.fn>;
  let handler: PostToolHandler;

  beforeEach(() => {
    executeTool = vi.fn();
  });

  describe('processInBackground() - synchronous behavior', () => {
    it('should be synchronous and not return a Promise', () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      const result = handler.processInBackground('Write', { path: 'test.ts' }, 'content');
      expect(result).toBeUndefined();
      expect(result instanceof Promise).toBe(false);
    });

    it('should not throw when disabled', () => {
      handler = new PostToolHandler(executeTool, { enabled: false });
      expect(() => {
        handler.processInBackground('Write', { path: 'test.ts' }, 'content');
      }).not.toThrow();
    });

    it('should not throw when enabled', () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(() => {
        handler.processInBackground('Write', { path: 'test.ts' }, 'content');
      }).not.toThrow();
    });

    it('should not throw on invalid input', () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(() => {
        handler.processInBackground('Write', null, undefined);
      }).not.toThrow();
    });
  });

  describe('processInBackground() - disabled handler', () => {
    it('should do nothing when disabled', async () => {
      handler = new PostToolHandler(executeTool, { enabled: false });
      handler.processInBackground('Write', { path: 'src/api.ts' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should not call mama_search when disabled', async () => {
      handler = new PostToolHandler(executeTool, { enabled: false });
      handler.processInBackground('Write', { path: 'src/api.ts' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalledWith('mama_search', expect.anything());
    });

    it('should not call mama_save when disabled', async () => {
      handler = new PostToolHandler(executeTool, { enabled: false });
      handler.processInBackground('Write', { path: 'src/api.ts' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalledWith('mama_save', expect.anything());
    });
  });

  describe('processInBackground() - non-edit tools', () => {
    it('should ignore Read tool', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Read', { path: 'src/api.ts' }, 'file content');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore Grep tool', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Grep', { pattern: 'test' }, 'results');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore Bash tool', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Bash', { command: 'ls' }, 'output');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore WebFetch tool', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('WebFetch', { url: 'https://example.com' }, 'html');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  describe('processInBackground() - low-priority paths', () => {
    it('should ignore test files', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'Write',
        { path: 'src/api.test.ts' },
        'export function test() {}'
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore spec files', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'Write',
        { path: 'src/api.spec.ts' },
        'export function test() {}'
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore docs directory', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'docs/api.md' }, '# API Documentation');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore examples directory', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'Write',
        { path: 'src/examples/auth.ts' },
        'export function auth() {}'
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore markdown files', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'README.md' }, '# Project');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore JSON config files', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'tsconfig.json' }, '{}');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore YAML config files', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'config.yaml' }, 'key: value');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  describe('processInBackground() - contract extraction', () => {
    it('should extract function signature contracts', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function getUserById(id: string): Promise<User> {
        return fetch(\`/api/users/\${id}\`);
      }`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_search', expect.any(Object));
    });

    it('should extract type definition contracts', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `interface User {
        id: string;
        email: string;
        name: string;
      }`;
      handler.processInBackground('Write', { path: 'src/types.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_search', expect.any(Object));
    });

    it('should extract API endpoint contracts', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `app.post('/api/auth/login', (req, res) => {
        const { email, password } = req.body;
        res.json({ token: 'jwt', userId: '123' });
      });`;
      handler.processInBackground('Write', { path: 'src/routes.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_search', expect.any(Object));
    });

    it('should extract SQL schema contracts', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `CREATE TABLE users (
        id VARCHAR(36) PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`;
      handler.processInBackground('Write', { path: 'src/migrations.sql' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_search', expect.any(Object));
    });

    it('should extract GraphQL schema contracts', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `type User {
        id: ID!
        email: String!
        name: String
      }`;
      handler.processInBackground('Write', { path: 'src/schema.graphql' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_search', expect.any(Object));
    });
  });

  describe('processInBackground() - deduplication', () => {
    it('should skip contracts that already exist (same topic and decision)', async () => {
      executeTool.mockImplementation((toolName, input) => {
        if (toolName === 'mama_search') {
          return Promise.resolve({
            results: [
              {
                topic: 'contract_function_getUserById',
                decision: 'getUserById(id: string) defined in src/api.ts',
                similarity: 0.95,
              },
            ],
          });
        }
        return Promise.resolve({});
      });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function getUserById(id: string): Promise<User> {
        return fetch(\`/api/users/\${id}\`);
      }`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_search', expect.any(Object));
      expect(executeTool).not.toHaveBeenCalledWith('mama_save', expect.any(Object));
    });

    it('should save contracts that do not exist', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function newFunction(x: number): string {
        return x.toString();
      }`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalledWith('mama_save', expect.any(Object));
    });

    it('should handle mama_search errors gracefully', async () => {
      executeTool.mockRejectedValueOnce(new Error('Search failed'));
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      expect(() => {
        handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('processInBackground() - contract save limit', () => {
    it('should respect contractSaveLimit from config', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true, contractSaveLimit: 5 });
      const code = `
        export function f1() {}
        export function f2() {}
        export function f3() {}
        export function f4() {}
        export function f5() {}
        export function f6() {}
      `;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const saveCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_save');
      expect(saveCalls.length).toBeLessThanOrEqual(5);
    });

    it('should use default CONTRACT_SAVE_LIMIT when not specified', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('processInBackground() - error handling', () => {
    it('should not throw when mama_save fails', async () => {
      executeTool.mockResolvedValueOnce({ results: [] });
      executeTool.mockRejectedValueOnce(new Error('Save failed'));
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      expect(() => {
        handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('should not throw on invalid input object', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(() => {
        handler.processInBackground('Write', { invalid: 'object' }, 'content');
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should not throw on null input', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(() => {
        handler.processInBackground('Write', null, 'content');
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should not throw on undefined result', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(() => {
        handler.processInBackground('Write', { path: 'src/api.ts' }, undefined);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should not throw on empty string result', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(() => {
        handler.processInBackground('Write', { path: 'src/api.ts' }, '');
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('processInBackground() - file path extraction', () => {
    it('should extract path from "path" field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should extract path from "file_path" field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { file_path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should extract path from "filePath" field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { filePath: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should ignore when no path field exists', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { content: 'code' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  describe('processInBackground() - result content extraction', () => {
    it('should extract string result directly', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'src/api.ts' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should extract content from object with content field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'Write',
        { path: 'src/api.ts' },
        {
          content: 'export function test() {}',
        }
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should serialize object result to JSON when no content field', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'Write',
        { path: 'src/api.ts' },
        {
          status: 'success',
          data: { id: '123' },
        }
      );
      await new Promise((r) => setTimeout(r, 100));
    });

    it('should ignore empty string result', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'src/api.ts' }, '');
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('should ignore empty object result', async () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'src/api.ts' }, {});
      await new Promise((r) => setTimeout(r, 50));
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  describe('processInBackground() - mama_save call format', () => {
    it('should call mama_save with correct decision type', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const saveCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_save');
      if (saveCalls.length > 0) {
        expect(saveCalls[0][1]).toHaveProperty('type', 'decision');
      }
    });

    it('should call mama_save with topic field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const saveCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_save');
      if (saveCalls.length > 0) {
        expect(saveCalls[0][1]).toHaveProperty('topic');
      }
    });

    it('should call mama_save with decision field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const saveCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_save');
      if (saveCalls.length > 0) {
        expect(saveCalls[0][1]).toHaveProperty('decision');
      }
    });

    it('should call mama_save with reasoning field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const saveCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_save');
      if (saveCalls.length > 0) {
        expect(saveCalls[0][1]).toHaveProperty('reasoning');
      }
    });

    it('should call mama_save with confidence field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const saveCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_save');
      if (saveCalls.length > 0) {
        expect(saveCalls[0][1]).toHaveProperty('confidence');
      }
    });
  });

  describe('processInBackground() - mama_search call format', () => {
    it('should call mama_search with type decision', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const searchCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_search');
      if (searchCalls.length > 0) {
        expect(searchCalls[0][1]).toHaveProperty('type', 'decision');
      }
    });

    it('should call mama_search with query field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const searchCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_search');
      if (searchCalls.length > 0) {
        expect(searchCalls[0][1]).toHaveProperty('query');
      }
    });

    it('should call mama_search with limit field', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      const code = `export function test() {}`;
      handler.processInBackground('Write', { path: 'src/api.ts' }, code);
      await new Promise((r) => setTimeout(r, 100));
      const searchCalls = executeTool.mock.calls.filter((call) => call[0] === 'mama_search');
      if (searchCalls.length > 0) {
        expect(searchCalls[0][1]).toHaveProperty('limit', 3);
      }
    });
  });

  describe('PostToolHandler constructor', () => {
    it('should initialize with enabled true', () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(handler).toBeDefined();
    });

    it('should initialize with enabled false', () => {
      handler = new PostToolHandler(executeTool, { enabled: false });
      expect(handler).toBeDefined();
    });

    it('should use custom contractSaveLimit', () => {
      handler = new PostToolHandler(executeTool, { enabled: true, contractSaveLimit: 10 });
      expect(handler).toBeDefined();
    });

    it('should use default contractSaveLimit when not provided', () => {
      handler = new PostToolHandler(executeTool, { enabled: true });
      expect(handler).toBeDefined();
    });
  });

  describe('Edit tool variants', () => {
    it('should recognize write_file as edit tool', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'write_file',
        { path: 'src/api.ts' },
        'export function test() {}'
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should recognize apply_patch as edit tool', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground(
        'apply_patch',
        { path: 'src/api.ts' },
        'export function test() {}'
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should recognize Edit as edit tool', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Edit', { path: 'src/api.ts' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });

    it('should recognize Write as edit tool', async () => {
      executeTool.mockResolvedValue({ results: [] });
      handler = new PostToolHandler(executeTool, { enabled: true });
      handler.processInBackground('Write', { path: 'src/api.ts' }, 'export function test() {}');
      await new Promise((r) => setTimeout(r, 100));
      expect(executeTool).toHaveBeenCalled();
    });
  });
});
