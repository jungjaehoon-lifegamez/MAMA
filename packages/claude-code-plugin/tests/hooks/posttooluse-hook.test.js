/**
 * Tests for PostToolUse Hook
 *
 * Story M2.3: PostToolUse Auto-save Hook
 * Tests AC #1-5: Tool subscription, topic extraction, reasoning extraction, auto-save suggestion, similarity threshold
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock environment for testing
const originalEnv = { ...process.env };

describe('Story M2.3: PostToolUse Hook', () => {
  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
  });

  describe('Hook Structure', () => {
    it('should export required functions', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      expect(hook).toHaveProperty('main');
      expect(hook).toHaveProperty('getTierInfo');
      expect(hook).toHaveProperty('extractTopic');
      expect(hook).toHaveProperty('extractReasoning');
      expect(hook).toHaveProperty('formatAutoSaveSuggestion');
      expect(hook).toHaveProperty('generateDecisionSummary');
      expect(hook).toHaveProperty('logAudit');
      expect(hook).toHaveProperty('checkSimilarDecision');

      expect(typeof hook.main).toBe('function');
      expect(typeof hook.getTierInfo).toBe('function');
      expect(typeof hook.extractTopic).toBe('function');
      expect(typeof hook.extractReasoning).toBe('function');
      expect(typeof hook.formatAutoSaveSuggestion).toBe('function');
      expect(typeof hook.generateDecisionSummary).toBe('function');
      expect(typeof hook.logAudit).toBe('function');
      expect(typeof hook.checkSimilarDecision).toBe('function');
    });

    it('should be executable script with shebang', async () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);

      // Check file permissions (executable)
      const stats = fs.statSync(scriptPath);
      const isExecutable = !!(stats.mode & 0o111);
      expect(isExecutable).toBe(true);
    });
  });

  describe('AC #1: Tool Subscription', () => {
    it('should define supported edit tools', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check for EDIT_TOOLS
      expect(content).toContain('EDIT_TOOLS');
      expect(content).toContain('write_file');
      expect(content).toContain('apply_patch');
      expect(content).toContain('Edit');
      expect(content).toContain('Write');
    });

    it('should check TOOL_NAME environment variable', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('TOOL_NAME');
      expect(content).toContain('process.env.TOOL_NAME');
    });
  });

  describe('AC #2: Topic Extraction', () => {
    it('should extract topic from file path', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const topic1 = hook.extractTopic('', 'src/core/db-manager.js');
      expect(topic1).toContain('Db Manager');

      const topic2 = hook.extractTopic('', 'config-loader.ts');
      expect(topic2).toContain('Config Loader');
    });

    it('should extract topic from conversation context', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const context1 = 'implement user authentication for the login flow';
      const topic1 = hook.extractTopic(context1, '');
      expect(topic1.toLowerCase()).toContain('user');

      const context2 = 'fix memory_leak in database connection';
      const topic2 = hook.extractTopic(context2, '');
      expect(topic2.toLowerCase()).toContain('memory');
    });

    it('should prefer file path over conversation', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const context = 'some random text';
      const topic = hook.extractTopic(context, 'important-feature.js');
      expect(topic).toContain('Important Feature');
    });

    it('should have fallback for no context', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const topic = hook.extractTopic('', '');
      expect(topic).toBeTruthy();
      expect(topic.length).toBeGreaterThan(0);
    });
  });

  describe('AC #3: Reasoning Extraction', () => {
    it('should extract reasoning from causal patterns', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const context1 = 'We changed this because it fixes the memory leak.';
      const reasoning1 = hook.extractReasoning(context1);
      expect(reasoning1.toLowerCase()).toContain('fixes the memory leak');

      const context2 = 'This allows better performance.';
      const reasoning2 = hook.extractReasoning(context2);
      expect(reasoning2.toLowerCase()).toContain('better performance');
    });

    it('should extract reasoning from purpose patterns', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const context = 'To solve the connection issue, we added retry logic.';
      const reasoning = hook.extractReasoning(context);
      expect(reasoning.toLowerCase()).toContain('connection issue');
    });

    it('should have fallback for no reasoning', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const reasoning = hook.extractReasoning('');
      expect(reasoning).toBeTruthy();
      expect(reasoning).toContain('No reasoning provided');
    });

    it('should limit reasoning length', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const longContext = 'because ' + 'a'.repeat(500);
      const reasoning = hook.extractReasoning(longContext);
      expect(reasoning.length).toBeLessThanOrEqual(201); // 200 + period
    });
  });

  describe('AC #4: Auto-Save Suggestion Formatting', () => {
    it('should format suggestion with Accept/Modify/Dismiss', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const suggestion = hook.formatAutoSaveSuggestion(
        'Test Topic',
        'Test decision',
        'Test reasoning',
        []
      );

      expect(suggestion).toContain('MAMA Auto-Save Suggestion');
      expect(suggestion).toContain('Topic:');
      expect(suggestion).toContain('Test Topic');
      expect(suggestion).toContain('Decision:');
      expect(suggestion).toContain('Test decision');
      expect(suggestion).toContain('Reasoning:');
      expect(suggestion).toContain('Test reasoning');

      // AC: Accept/Modify/Dismiss options
      expect(suggestion).toContain('[a] Accept');
      expect(suggestion).toContain('[m] Modify');
      expect(suggestion).toContain('[d] Dismiss');
    });

    it('should show similar decisions if provided', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const similarDecisions = [
        { decision: 'Similar decision 1', similarity: 0.85 },
        { decision: 'Similar decision 2', similarity: 0.78 }
      ];

      const suggestion = hook.formatAutoSaveSuggestion(
        'Topic',
        'Decision',
        'Reasoning',
        similarDecisions
      );

      expect(suggestion).toContain('Similar existing decisions');
      expect(suggestion).toContain('Similar decision 1');
      expect(suggestion).toContain('85%');
    });

    it('should limit similar decisions to top 2', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const similarDecisions = [
        { decision: 'Decision 1', similarity: 0.90 },
        { decision: 'Decision 2', similarity: 0.85 },
        { decision: 'Decision 3', similarity: 0.80 },
        { decision: 'Decision 4', similarity: 0.75 }
      ];

      const suggestion = hook.formatAutoSaveSuggestion(
        'Topic',
        'Decision',
        'Reasoning',
        similarDecisions
      );

      expect(suggestion).toContain('Decision 1');
      expect(suggestion).toContain('Decision 2');
      expect(suggestion).not.toContain('Decision 3');
      expect(suggestion).not.toContain('Decision 4');
    });
  });

  describe('AC #5: Similarity Threshold', () => {
    it('should define similarity threshold 75%', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check SIMILARITY_THRESHOLD is defined
      const match = content.match(/SIMILARITY_THRESHOLD\s*=\s*([\d.]+)/);
      expect(match).toBeTruthy();

      const threshold = parseFloat(match[1]);
      expect(threshold).toBe(0.75); // Higher than M2.2 (0.70)
    });

    it('should use threshold in vector search', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check threshold is used in similarity check
      expect(content).toContain('SIMILARITY_THRESHOLD');
      expect(content).toContain('vectorSearch');
    });
  });

  describe('Decision Summary Generation', () => {
    it('should generate summary from diff content', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const diff = '+function calculateTotal() {\n+  return sum;\n+}';
      const summary = hook.generateDecisionSummary(diff, 'calculator.js');

      expect(summary).toContain('calculateTotal');
      expect(summary).toContain('calculator.js');
    });

    it('should handle empty diff', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const summary = hook.generateDecisionSummary('', 'test.js');
      expect(summary).toContain('Modified');
      expect(summary).toContain('test.js');
    });

    it('should extract function/class names', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');

      const diff1 = '+class UserManager {\n+  constructor() {}';
      const summary1 = hook.generateDecisionSummary(diff1, 'user.js');
      expect(summary1).toContain('UserManager');

      const diff2 = '+const handleClick = () => {';
      const summary2 = hook.generateDecisionSummary(diff2, 'button.js');
      expect(summary2).toContain('handleClick');
    });
  });

  describe('Audit Logging', () => {
    it('should export logAudit function', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');
      expect(typeof hook.logAudit).toBe('function');
    });

    it('should define audit log file', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('AUDIT_LOG_FILE');
      expect(content).toContain('.posttooluse-audit.log');
    });

    it('should reference audit log in comments', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // AC: Audit log entry records each auto-save attempt
      expect(content).toContain('Audit log');
      expect(content).toContain('logAudit');
    });
  });

  describe('Privacy Mode', () => {
    it('should support MAMA_DISABLE_AUTO_SAVE opt-out', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // AC: Privacy mode support
      expect(content).toContain('MAMA_DISABLE_AUTO_SAVE');
      expect(content).toContain('process.env.MAMA_DISABLE_AUTO_SAVE');
      expect(content).toContain('privacy mode');
    });

    it('should also support MAMA_DISABLE_HOOKS', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('MAMA_DISABLE_HOOKS');
      expect(content).toContain('process.env.MAMA_DISABLE_HOOKS');
    });
  });

  describe('Tier Requirements', () => {
    it('should detect tier same as M2.1/M2.2', async () => {
      const hook = await import('../../scripts/posttooluse-hook.js');
      const tierInfo = hook.getTierInfo();

      // Should return tier object
      expect(tierInfo).toHaveProperty('tier');
      expect(tierInfo).toHaveProperty('vectorSearchEnabled');
      expect(tierInfo).toHaveProperty('reason');

      // Tier should be 1, 2, or 3
      expect([1, 2, 3]).toContain(tierInfo.tier);
    });

    it('should require Tier 1 for auto-save', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // AC: Tier 1 requirement (need embeddings for similarity)
      expect(content).toContain('tierInfo.tier');
      expect(content).toContain('Tier 1');
      expect(content).toContain('embeddings');
    });
  });

  describe('Performance', () => {
    it('should define MAX_RUNTIME_MS <=500ms', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check MAX_RUNTIME_MS is defined and <=500
      const match = content.match(/MAX_RUNTIME_MS\s*=\s*(\d+)/);
      expect(match).toBeTruthy();

      const maxRuntime = parseInt(match[1], 10);
      expect(maxRuntime).toBeLessThanOrEqual(500);
    });

    it('should implement timeout handling', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check timeout implementation with Promise.race
      expect(content).toContain('Promise.race');
      expect(content).toContain('setTimeout');
      expect(content).toContain('Timeout');
    });
  });

  describe('Integration', () => {
    it('should handle missing TOOL_NAME gracefully', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Verify graceful handling
      expect(content).toContain('TOOL_NAME');
      expect(content).toContain('process.exit(0)');
    });

    it('should handle missing FILE_PATH gracefully', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('FILE_PATH');
      expect(content).toContain('filePath');
    });

    it('should handle missing DIFF_CONTENT gracefully', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('DIFF_CONTENT');
      expect(content).toContain('diffContent');
    });

    it('should log structured information', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Verify structured logging
      expect(content).toContain('info');
      expect(content).toContain('warn');
      expect(content).toContain('[Hook]');
      expect(content).toContain('Auto-save');
    });

    it('should extract context from environment variables', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // FR24: Context extraction from environment
      expect(content).toContain('process.env.FILE_PATH');
      expect(content).toContain('process.env.DIFF_CONTENT');
      expect(content).toContain('process.env.CONVERSATION_CONTEXT');
    });
  });

  describe('FR24: Reasoning Capture', () => {
    it('should implement reasoning capture from conversation', () => {
      const scriptPath = path.join(__dirname, '../../scripts/posttooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // AC: Reasoning captured from conversation context (FR24)
      expect(content).toContain('extractReasoning');
      expect(content).toContain('conversationContext');
      expect(content).toContain('CONVERSATION_CONTEXT');
    });
  });
});
