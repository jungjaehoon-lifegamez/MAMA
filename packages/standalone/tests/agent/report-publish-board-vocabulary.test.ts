/**
 * report_publish board-vocabulary observability.
 *
 * A board slot is a reversible durable write, so slot HTML that misses the
 * board class vocabulary is still published (observability over restriction).
 * The run must be able to see that it happened: the tool result carries a
 * warning and the daemon log carries one line naming the slot and the run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';
import {
  boardHtmlClassVocabulary,
  boardStructuralClasses,
  buildReportPublishToolContract,
  htmlUsesBoardVocabulary,
} from '../../src/operator/board-slot-instructions.js';

const createMockApi = (): MAMAApiInterface =>
  ({
    save: vi.fn().mockResolvedValue({ success: true, id: 'd1', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    recallMemory: vi.fn().mockResolvedValue({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: '', scope_order: [], retrieval_sources: [] },
    }),
    ingestMemory: vi.fn().mockResolvedValue({ success: true }),
    appendToolTrace: vi.fn().mockResolvedValue(undefined),
    beginModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_abc' }),
    commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_abc' }),
    failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_abc' }),
  }) as unknown as MAMAApiInterface;

const agentContext = () => ({
  source: 'viewer',
  platform: 'viewer' as const,
  roleName: 'os_agent',
  role: { allowedTools: ['*'], systemControl: true, sensitiveAccess: true },
  session: { sessionId: 'test-session', startedAt: new Date() },
  capabilities: ['All tools'],
  limitations: [],
});

const VOCABULARY_HTML =
  '<div class="report-summary"><div class="summary-title">Today</div></div>' +
  '<div class="report-card"><div class="card-header"><div class="card-title">A</div>' +
  '<span class="card-badge badge-warning">waiting</span></div>' +
  '<div class="card-action">Confirm the invoice</div></div>';

const GENERIC_HTML = '<section><h3>Today</h3><ul><li>report-card is only text here</li></ul></section>';

// The 19:59 live slot: invented card-grid/card wrapper, real badge sub-classes.
const LIVE_1959_HTML =
  '<div class="card-grid">' +
  '<article class="card"><h4>Invoice</h4>' +
  '<span class="badge badge-info">in progress</span></article>' +
  '</div>';

// The 20:06 live slot: summary-* and tag-* sub-element classes, no structural block.
const LIVE_2006_HTML =
  '<div class="summary-stats">open <span class="stat-highlight">3</span></div>' +
  '<div class="card-header"><div class="card-title">Ship</div>' +
  '<span class="card-badge badge-warning">waiting</span></div>' +
  '<div class="card-tags"><span class="tag tag-channel">ops</span></div>';

describe('report_publish board vocabulary warning', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('derives the class vocabulary from the published contract text', () => {
    const vocabulary = boardHtmlClassVocabulary();
    for (const expected of [
      'report-summary',
      'summary-title',
      'report-section-title',
      'report-card',
      'card-header',
      'card-title',
      'card-badge',
      'card-action',
      'card-tags',
      'tag',
      'tag-channel',
      'report-table',
      'badge-danger',
      'badge-warning',
      'badge-info',
      'badge-success',
    ]) {
      expect(vocabulary.has(expected)).toBe(true);
    }
    // The structural subset is the one a slot must actually carry.
    expect([...vocabulary.structural].sort()).toEqual([...boardStructuralClasses()].sort());
    expect(boardStructuralClasses()).toEqual([
      'report-summary',
      'report-section-title',
      'report-card',
      'report-table',
    ]);

    // Exact: class tokens only, never prose substrings.
    expect(htmlUsesBoardVocabulary(GENERIC_HTML)).toBe(false);
    expect(htmlUsesBoardVocabulary('<p class="reportcard">x</p>')).toBe(false);
    expect(htmlUsesBoardVocabulary(VOCABULARY_HTML)).toBe(true);
  });

  it('rejects sub-element classes without a structural block', () => {
    // Invented classes the agent reached for when it never saw the contract.
    expect(htmlUsesBoardVocabulary(LIVE_1959_HTML)).toBe(false);
    expect(htmlUsesBoardVocabulary(LIVE_2006_HTML)).toBe(false);
    // Real vocabulary tokens, but decoration only: still not board HTML.
    expect(htmlUsesBoardVocabulary('<span class="badge badge-info">x</span>')).toBe(false);
    expect(htmlUsesBoardVocabulary('<span class="tag tag-channel">ops</span>')).toBe(false);
    expect(htmlUsesBoardVocabulary('<div class="summary-title">T</div>')).toBe(false);
    expect(htmlUsesBoardVocabulary('<div class="card-title">T</div>')).toBe(false);
    expect(htmlUsesBoardVocabulary('<div class="card-grid"><div class="card">x</div></div>')).toBe(
      false
    );
    // Any single structural block is enough.
    for (const structural of boardStructuralClasses()) {
      expect(htmlUsesBoardVocabulary(`<div class="${structural}">x</div>`)).toBe(true);
    }
    expect(
      htmlUsesBoardVocabulary('<div class="report-card"><span class="badge-info">x</span></div>')
    ).toBe(true);
  });

  it('emits no warning when every slot uses the vocabulary', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    executor.setAgentContext(agentContext());
    const publisher = vi.fn();
    executor.setReportPublisher(publisher);

    const result = await executor.execute('report_publish', {
      slots: { briefing: VOCABULARY_HTML, decisions: VOCABULARY_HTML },
    });

    expect(result).toMatchObject({ success: true });
    expect(result).not.toHaveProperty('warnings');
    expect(result).not.toHaveProperty('contract');
    expect(publisher).toHaveBeenCalledOnce();
    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('[board] slot'))
    ).toHaveLength(0);
  });

  it('warns in the result and the log but still publishes a generic-HTML slot', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    executor.setAgentContext(agentContext());
    const publisher = vi.fn();
    executor.setReportPublisher(publisher);

    const result = (await executor.execute(
      'report_publish',
      { slots: { briefing: GENERIC_HTML, decisions: VOCABULARY_HTML } },
      {
        agentId: 'host',
        source: 'watch',
        channelId: 'c1',
        executionSurface: 'direct',
        modelRunId: 'run_abc',
      }
    )) as {
      success: boolean;
      acceptedSlotIds: string[];
      warnings?: string[];
      contract?: string;
    };

    // Publish still recorded, unchanged.
    expect(result.success).toBe(true);
    expect(result.acceptedSlotIds).toEqual(['briefing', 'decisions']);
    expect(publisher).toHaveBeenCalledOnce();
    expect(publisher.mock.calls[0][0]).toMatchObject({ briefing: GENERIC_HTML });

    expect(result.warnings).toEqual([
      'slot briefing uses none of the board structural classes (report-summary / report-card / report-section-title / report-table) and will render as plain text; republish using the report_publish contract (tool_describe report_publish)',
    ]);
    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[board]'))
    ).toEqual(['[board] slot briefing published without the board vocabulary (run run_abc)']);
 
    // The shape is handed back once, not per slot, so the republish needs no
    // second lookup.
    expect(result.contract).toBe(buildReportPublishToolContract());
  });

  it('labels the run as unknown when no model run is bound', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    executor.setAgentContext(agentContext());
    executor.setReportPublisher(vi.fn());

    await executor.execute('report_publish', { slots: { briefing: GENERIC_HTML } });

    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[board]'))
    ).toEqual(['[board] slot briefing published without the board vocabulary (run unknown)']);
  });
});
