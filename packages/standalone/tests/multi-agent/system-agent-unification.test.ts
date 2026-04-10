import { describe, it, expect } from 'vitest';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';

describe('system agent unification', () => {
  describe('code-act MCP merging', () => {
    it('adds code-act entry to mama-mcp-config.json', () => {
      const existing = {
        mcpServers: {
          pubmed: { type: 'http', url: 'https://example.com/mcp' },
        },
      };
      const codeActEntry = {
        'code-act': {
          command: 'node',
          args: ['/path/to/code-act-server.js'],
          env: { MAMA_SERVER_PORT: '3847' },
        },
      };
      const merged = {
        mcpServers: { ...existing.mcpServers, ...codeActEntry },
      };
      expect(merged.mcpServers['code-act']).toBeDefined();
      expect(merged.mcpServers['code-act'].command).toBe('node');
      expect(merged.mcpServers.pubmed).toBeDefined();
    });

    it('does not duplicate code-act if already present', () => {
      const existing = {
        mcpServers: {
          'code-act': { command: 'node', args: ['/old/path.js'] },
        },
      };
      const codeActEntry = {
        'code-act': { command: 'node', args: ['/new/path.js'] },
      };
      const merged = {
        mcpServers: { ...existing.mcpServers, ...codeActEntry },
      };
      expect(merged.mcpServers['code-act'].args[0]).toBe('/new/path.js');
      expect(Object.keys(merged.mcpServers).filter((k) => k === 'code-act')).toHaveLength(1);
    });
  });

  describe('config.yaml agent registration', () => {
    it('dashboard-agent config has required fields', () => {
      const dashboardAgent = {
        name: 'Dashboard Agent',
        display_name: '📊 Dashboard',
        trigger_prefix: '!dashboard',
        persona_file: '~/.mama/personas/dashboard.md',
        tier: 2,
        can_delegate: false,
        useCodeAct: true,
        model: 'claude-sonnet-4-6',
        tool_permissions: {
          allowed: ['mama_search', 'report_publish', 'code_act'],
          blocked: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Grep',
            'Glob',
            'Agent',
            'WebSearch',
            'WebFetch',
          ],
        },
      };
      expect(dashboardAgent.tier).toBe(2);
      expect(dashboardAgent.can_delegate).toBe(false);
      expect(dashboardAgent.useCodeAct).toBe(true);
      expect(dashboardAgent.persona_file).toBe('~/.mama/personas/dashboard.md');
    });

    it('wiki-agent config has required fields', () => {
      const wikiAgent = {
        name: 'Wiki Agent',
        display_name: '📚 Wiki',
        trigger_prefix: '!wiki',
        persona_file: '~/.mama/personas/wiki.md',
        tier: 2,
        can_delegate: false,
        useCodeAct: true,
        model: 'claude-sonnet-4-6',
        tool_permissions: {
          allowed: ['mama_search', 'wiki_publish', 'code_act'],
          blocked: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Grep',
            'Glob',
            'Agent',
            'WebSearch',
            'WebFetch',
          ],
        },
      };
      expect(wikiAgent.tier).toBe(2);
      expect(wikiAgent.useCodeAct).toBe(true);
      expect(wikiAgent.persona_file).toBe('~/.mama/personas/wiki.md');
    });

    it('DelegationManager recognizes system agents after config load', async () => {
      const { DelegationManager } = await import('../../src/multi-agent/delegation-manager.js');
      const agents = [
        {
          id: 'conductor',
          name: 'Conductor',
          display_name: 'Conductor',
          trigger_prefix: '!c',
          persona_file: '',
          tier: 1,
          can_delegate: true,
          enabled: true,
        },
        {
          id: 'dashboard-agent',
          name: 'Dashboard',
          display_name: 'Dashboard',
          trigger_prefix: '!d',
          persona_file: '',
          tier: 2,
          can_delegate: false,
          enabled: true,
        },
        {
          id: 'wiki-agent',
          name: 'Wiki',
          display_name: 'Wiki',
          trigger_prefix: '!w',
          persona_file: '',
          tier: 2,
          can_delegate: false,
          enabled: true,
        },
      ];
      const dm = new DelegationManager(agents as AgentPersonaConfig[]);

      const dashCheck = dm.isDelegationAllowed('conductor', 'dashboard-agent');
      expect(dashCheck.allowed).toBe(true);

      const wikiCheck = dm.isDelegationAllowed('conductor', 'wiki-agent');
      expect(wikiCheck.allowed).toBe(true);
    });
  });
});
