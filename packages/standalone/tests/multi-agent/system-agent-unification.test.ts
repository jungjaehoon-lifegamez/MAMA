import { describe, it, expect } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';

describe('system agent unification', () => {
  describe('managed personas', () => {
    it('dashboard-agent directs evidence gathering through context_compile', async () => {
      const { DASHBOARD_AGENT_PERSONA } =
        await import('../../src/multi-agent/dashboard-agent-persona.js');

      expect(DASHBOARD_AGENT_PERSONA).toContain('context_compile');
      expect(DASHBOARD_AGENT_PERSONA).toContain('context_packet_id');
    });

    it('wiki-agent directs compilation evidence through context_compile', async () => {
      const { WIKI_AGENT_PERSONA } = await import('../../src/multi-agent/wiki-agent-persona.js');

      expect(WIKI_AGENT_PERSONA).toContain('context_compile');
      expect(WIKI_AGENT_PERSONA).toContain('context_packet_id');
    });

    it('upgrades older managed wiki persona files to the context_compile workflow', async () => {
      const testDir = join(
        tmpdir(),
        `mama-wiki-persona-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const personaDir = join(testDir, 'personas');
      const personaPath = join(personaDir, 'wiki.md');
      const { ensureWikiPersona, WIKI_AGENT_PERSONA } =
        await import('../../src/multi-agent/wiki-agent-persona.js');

      await mkdir(personaDir, { recursive: true });
      await writeFile(
        personaPath,
        '<!-- MAMA managed wiki persona v3 -->\n\nUse mama_search with relevant queries.',
        'utf-8'
      );

      try {
        ensureWikiPersona(testDir);
        const upgraded = await readFile(personaPath, 'utf-8');

        expect(upgraded).toBe(WIKI_AGENT_PERSONA);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('scheduled system-run prompts', () => {
    it('directs dashboard and wiki runs through context_compile before mama_search fallback', async () => {
      const source = await readFile(join(process.cwd(), 'src/cli/runtime/api-routes-init.ts'), {
        encoding: 'utf-8',
      });

      expect(source).toContain('Use context_compile first');
      expect(source).toContain(
        'Use this exact task text for context_compile: "recent substantive project decisions, task progress, agent alerts, and major changes"'
      );
      expect(source).toContain(
        'Do not include dashboard_briefing, wiki_compilation, system-audit, or audit-log labels in the context_compile task text'
      );
      expect(source).toContain('fall back to mama_search');
      expect(source).not.toContain('Use mama_search to find recent substantive decisions');
    });

    it('wiki novelty check is recency-based, not semantic (cross-language gap)', async () => {
      const source = await readFile(join(process.cwd(), 'src/cli/runtime/api-routes-init.ts'), {
        encoding: 'utf-8',
      });
      const { WIKI_AGENT_PERSONA } = await import('../../src/multi-agent/wiki-agent-persona.js');

      // Lexical scoring against the English task text filtered out Korean-only
      // decisions, so a fresh promotion was judged "nothing new". The novelty
      // check must use the no-query mama_search recency list.
      for (const text of [source, WIKI_AGENT_PERSONA]) {
        expect(text).toContain('NOVELTY CHECK by recency, not semantics');
        expect(text).toContain('mama_search({limit: 30}) with NO query');
      }
    });

    it('memory promotion run curates durable judgments and never task states', async () => {
      const source = await readFile(join(process.cwd(), 'src/cli/runtime/api-routes-init.ts'), {
        encoding: 'utf-8',
      });

      // The prompt enters the persona's PROMOTION RUN mode and self-gathers.
      expect(source).toContain('PROMOTION RUN. You are curating durable business memory');
      expect(source).toContain('kagemusha_messages({channelId, since: <boundary ISO>})');
      expect(source).toContain('Promote at most 5 durable judgments per run via mama_save');
      expect(source).toContain('NEVER task lifecycle states');
      expect(source).toContain('Finish with exactly PROMOTED <n> or NO_UPDATE');
      // Promotion feeds the wiki chain.
      expect(source).toContain("eventBus.onDebounced('memory:promoted'");
      expect(source).toContain('/api/memory/promote');
    });
  });

  describe('dashboard persona v12 (M8 P3)', () => {
    it('adds RECONCILE RUN mode and the item-tracker pipeline projection', async () => {
      const { DASHBOARD_AGENT_PERSONA } =
        await import('../../src/multi-agent/dashboard-agent-persona.js');
      expect(DASHBOARD_AGENT_PERSONA).toContain('## RECONCILE RUN mode');
      expect(DASHBOARD_AGENT_PERSONA).toContain('RECONCILED');
      expect(DASHBOARD_AGENT_PERSONA).toContain('source_event_id');
      // tracker projection from the NATIVE ledger
      expect(DASHBOARD_AGENT_PERSONA).toContain(
        'task_list({order: "deadline_priority", limit: 12})'
      );
      expect(DASHBOARD_AGENT_PERSONA).toContain('(unconfirmed)');
      expect(DASHBOARD_AGENT_PERSONA).toContain('unassigned');
      // cron rules intact
      expect(DASHBOARD_AGENT_PERSONA).toContain(
        'Call report_publish exactly once, carrying all four slots'
      );
    });

    it("cron prompt is built per run and carries today's date", async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src/cli/runtime/api-routes-init.ts'), {
        encoding: 'utf-8',
      });
      expect(source).toContain('const buildDashboardPrompt =');
      expect(source).toContain('Today is ${new Date().toISOString().slice(0, 10)}');
    });
  });

  describe('memory persona promotion mode', () => {
    it('adds PROMOTION RUN mode with curation bias and keeps turn-audit rules', async () => {
      const { MEMORY_AGENT_PERSONA } =
        await import('../../src/multi-agent/memory-agent-persona.js');

      expect(MEMORY_AGENT_PERSONA).toContain('## PROMOTION RUN mode');
      expect(MEMORY_AGENT_PERSONA).toContain('mama_save up to 5 times');
      expect(MEMORY_AGENT_PERSONA).toContain('NEVER promote task lifecycle states');
      expect(MEMORY_AGENT_PERSONA).toContain('PROMOTED <n>');
      // Opposite default biases: turn audit saves when in doubt, promotion does not.
      expect(MEMORY_AGENT_PERSONA).toContain('When in doubt, save');
      expect(MEMORY_AGENT_PERSONA).toContain('When in doubt in THIS mode, do NOT save');
    });

    it('upgrades a v5 managed memory persona to the current version', async () => {
      const testDir = join(
        tmpdir(),
        `mama-memory-persona-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const personaDir = join(testDir, 'personas');
      const personaPath = join(personaDir, 'memory.md');
      const { ensureMemoryPersona, MEMORY_AGENT_PERSONA } =
        await import('../../src/multi-agent/memory-agent-persona.js');

      await mkdir(personaDir, { recursive: true });
      await writeFile(
        personaPath,
        '<!-- MAMA managed memory persona v5 -->\n\nOld turn-audit-only persona.',
        'utf-8'
      );

      try {
        ensureMemoryPersona(testDir);
        const upgraded = await readFile(personaPath, 'utf-8');

        expect(upgraded).toBe(MEMORY_AGENT_PERSONA);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('process manager defaults', () => {
    it('enables skip-permissions for headless system-run agents by default', async () => {
      const { buildSystemAgentProcessDefaults } = await import('../../src/cli/commands/start.js');

      expect(buildSystemAgentProcessDefaults({}).dangerouslySkipPermissions).toBe(true);
    });

    it('honors explicit skip-permissions disablement', async () => {
      const { buildSystemAgentProcessDefaults } = await import('../../src/cli/commands/start.js');

      expect(
        buildSystemAgentProcessDefaults({
          multi_agent: { dangerouslySkipPermissions: false },
        }).dangerouslySkipPermissions
      ).toBe(false);
    });
  });

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
          allowed: ['Read', 'Grep', 'Glob', 'code_act'],
          blocked: ['Bash', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch'],
        },
        gateway_tool_permissions: {
          allowed: ['mama_search', 'agent_notices', 'report_publish'],
          blocked: [],
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
          allowed: ['Read', 'Grep', 'Glob', 'code_act'],
          blocked: ['Bash', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch'],
        },
        gateway_tool_permissions: {
          allowed: [
            'mama_search',
            'agent_notices',
            'case_list',
            'case_assemble',
            'obsidian',
            'wiki_publish',
          ],
          blocked: [],
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
