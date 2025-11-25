# MAMA Checkpoint Template v2: Truthful Continuity

# Purpose: Let the next LLM act immediately by sharing reality—unfinished work and risks included.

## Pre-save Quick Check

- Any TODOs/unfinished items? Note where/why you stopped.
- Did you run tests/health checks? If not, mark `Not run` with a reason.
- Any assumptions? Mark them as `Assumed`.

## Post-resume Trust Lift (quickly raise confidence)

- Run 1-2 quick checks from Next Agent and mark their status.
- Sample-verify at least one claim per section (files/logs/commands) and note the command/output path.
- If code changed, re-label stale items (Assumed → Verified/Not run) and re-save the checkpoint.
- Show a “Trust lift” block in resume with 2-3 commands, expected time, and what they confirm.

## 1. 🎯 Goal & Progress

> "What was the goal, and where did we stop?"

- **Goal**: [Core objective for this session]
- **Progress**: [What you did, where you paused, why unfinished]

## 2. ✅ Evidence & Verification

> "Don't trust me—trust these checks."

- **Claim**: [Current state assertion]
- **Evidence** (label each with a status):
  - File: `path/to/file.js` — Status: **Verified / Not run / Assumed** (cite tests/logs/lines)
  - Command: `npm test api` — Status: **Verified**
  - Log/Output: `[MAMA MCP] ...` — Status: **Assumed** (reused log)
- **Verification Tip**: [Command/path the next LLM can run to confirm]

## 3. ⏳ Unfinished & Risks

> "Here’s what’s missing or risky."

- **Remaining Work**: [What’s left]
- **Not Run**: [Tests/health checks not run + reason]
- **Risks/Unknowns**: [Blocks, uncertainties, potential issues]

## 4. 🚦 Next Agent Briefing

> "Define and execute the next move."

- **Target Outcome (DoD)**: [State to verify on completion]
- **Quick Checks**: [Commands to run, e.g., `npm test auth`, `curl http://localhost:3000/health`]
- **Constraints**: [Constraints or cautions]

---

## Example Usage

### 1. 🎯 Goal & Progress

- **Goal**: Finish JWT refresh flow
- **Progress**: Issuance/validation written; refresh rotation unfinished (spec pending, paused)

### 2. ✅ Evidence & Verification

- **Claim**: Access-token verification logic added
- **Evidence**:
  - File: `packages/api/auth.js` — Status: **Verified** (unit test `npm test auth` passed)
  - Command: `npm run e2e` — Status: **Not run** (takes ~10m)
- **Verification Tip**: Run `npm test auth`; `grep -n "refresh" packages/api/auth.js` to confirm remaining TODOs

### 3. ⏳ Unfinished & Risks

- **Remaining Work**: Implement refresh rotation; decide token lifetime
- **Not Run**: E2E tests not run (time budget)
- **Risks/Unknowns**: Debug logging may leak tokens

### 4. 🚦 Next Agent Briefing

- **Target Outcome (DoD)**: Refresh flow implemented; tokens not logged
- **Quick Checks**: `npm test auth`, `curl http://localhost:3000/health`
- **Constraints**: Keep compatibility with existing token expiry policy
