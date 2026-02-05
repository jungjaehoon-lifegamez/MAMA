# PRD: Context-First Contract Flow (BMAD)

**Owner:** Team MAMA  
**Date:** 2026-02-05  
**Status:** Draft

## **B — Background**

Agents often write speculative code when context is missing, especially across frontend/backend/DB boundaries. This leads to schema drift, broken integrations, and “shell-only” implementations. We want a flow that forces context retrieval first, makes reasoning visible, and then persists contracts so future sessions remain grounded.

## **M — Metrics**

Success is defined by measurable reduction in speculative code and faster task completion.

- Contract retrieval before edit rate: ≥ 90% of relevant read/edit actions
- Contract-based code usage: ≥ 80% of new code uses contract fields as-is
- Schema mismatch bugs: −50% vs baseline
- Mean time to correct context: < 15 seconds after PreToolUse
- User-reported “hallucinated schema” incidents: near zero

## **A — Assumptions**

- PreToolUse and PostToolUse hooks can run synchronously with tool usage.
- MCP storage is available for storing and retrieving contracts/decisions.
- Contracts can be represented in a neutral schema with language-specific formatting layered on top.
- Engineers accept “blocking” warnings when no contract exists.

## **D — Deliverables**

- PreToolUse hook that performs MCP search and injects results plus reasoning.
- PostToolUse hook that extracts contracts and provides explicit save instructions.
- Contract storage format with neutral schema and case/alias mapping.
- Onboarding profile to tailor behavior per role and language.

## **Goals**

- Make context retrieval a required step before reading/editing code.
- Ensure saved contracts prevent schema drift across sessions.
- Provide reasoning summaries to avoid black-box automation.
- Support multi-language naming conversions (camel, snake, Pascal).

## **Non-Goals**

- Full code generation automation.
- Eliminating all manual verification.
- Replacing existing API spec tools.

## **Personas**

- Frontend engineer integrating with backend APIs.
- Backend engineer defining or evolving request/response schemas.
- Game client engineer integrating with game server events.
- Data/DB engineer maintaining storage schema.

## **User Stories**

1. As a frontend engineer, I must see exact request/response fields before coding.
2. As a backend engineer, I want my updated API contract stored automatically.
3. As a cross-team developer, I want language/case differences mapped clearly.
4. As a new team member, I want onboarding that configures rules for my stack.

## **Functional Requirements**

1. PreToolUse must execute MCP search and show contract-only results.
2. PreToolUse must include a reasoning summary grounded in actual results.
3. If no contract exists, PreToolUse must show a blocking warning and a save template.
4. PostToolUse must detect contracts and instruct save with explicit schema.
5. Contract storage must support aliases and case mapping.

## **Non-Functional Requirements**

1. PreToolUse latency target: ≤ 2 seconds p95.
2. PostToolUse latency target: ≤ 3 seconds p95.
3. Avoid hallucinated reasoning: only derived from real evidence.
4. Minimize false positives by filtering noise and irrelevant results.

## **Risks & Mitigations**

- Risk: Users ignore warnings and continue with guesses.
  Mitigation: Escalate warning severity and require explicit acknowledgment.
- Risk: Contract search returns unrelated items.
  Mitigation: Use token matching and contract-only filtering.
- Risk: Case mapping causes confusion.
  Mitigation: Display mapping rules in reasoning summary.

## **Milestones**

1. PreToolUse auto-search + reasoning summary (complete)
2. PostToolUse contract extraction + save guidance (complete)
3. Contract aliasing + case mapping (planned)
4. Onboarding profiles stored in MCP (planned)
