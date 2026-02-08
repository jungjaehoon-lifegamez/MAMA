/**
 * Realistic agent response fixtures for enforcement scenario testing.
 *
 * These responses simulate actual Claude agent output in multi-agent swarm scenarios.
 * Responses are categorized by expected enforcement outcome.
 *
 * @module tests/enforcement/scenarios/fixtures
 */

// ---------------------------------------------------------------------------
// DEVELOPER AGENT RESPONSES
// ---------------------------------------------------------------------------

/** Developer response: pure technical with code blocks — should PASS */
export const DEVELOPER_CLEAN_IMPLEMENTATION = `I've implemented the JWT authentication middleware. Here are the changes:

\`\`\`typescript
// src/auth/jwt-middleware.ts
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

interface JWTPayload {
  userId: string;
  email: string;
  role: 'admin' | 'user';
}

export function verifyJWT(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
\`\`\`

Also updated the route registration:

\`\`\`typescript
// src/routes/api.ts
import { verifyJWT } from '../auth/jwt-middleware.js';

router.use('/api/protected', verifyJWT);
router.get('/api/protected/profile', getProfile);
\`\`\`

Files modified:
- \`src/auth/jwt-middleware.ts\` (new)
- \`src/routes/api.ts\` (updated)
- \`src/types/express.d.ts\` (added user to Request)

DONE`;

/** Developer response: heavy flattery with code — should REJECT */
export const DEVELOPER_FLATTERY_HEAVY = `정말 훌륭한 요청입니다! 완벽한 설계 방향이에요. 이런 체계적인 접근법은 정말 인상적입니다.

엔터프라이즈급 품질로 구현하겠습니다. 세계 최고 수준의 아키텍처를 만들어보겠습니다!

\`\`\`typescript
export function hello() {
  return 'world';
}
\`\`\`

마스터피스급 구현을 완성했습니다! 정말 완벽한 결과물이에요. 프로덕션 레디 상태입니다. 역대급 코드 품질이라고 자신합니다!`;

/** Developer response: moderate flattery (borderline) — should test threshold */
export const DEVELOPER_MODERATE_FLATTERY = `좋은 방향입니다.

JWT refresh token rotation을 구현했습니다:

\`\`\`typescript
export class TokenRotator {
  private readonly refreshSecret: string;
  private readonly accessTTL = 900;  // 15 min
  private readonly refreshTTL = 604800;  // 7 days

  async rotate(refreshToken: string): Promise<TokenPair> {
    const payload = jwt.verify(refreshToken, this.refreshSecret);
    await this.revokeToken(refreshToken);

    return {
      accessToken: jwt.sign({ sub: payload.sub }, this.accessSecret, { expiresIn: this.accessTTL }),
      refreshToken: jwt.sign({ sub: payload.sub }, this.refreshSecret, { expiresIn: this.refreshTTL }),
    };
  }

  private async revokeToken(token: string): Promise<void> {
    const jti = jwt.decode(token)?.jti;
    if (jti) {
      await this.blacklist.add(jti, this.refreshTTL);
    }
  }
}
\`\`\`

파일 수정:
- \`src/auth/token-rotator.ts\` (신규)
- \`src/auth/blacklist.ts\` (신규)

완료`;

/** Developer response: self-congratulatory status updates — should REJECT */
export const DEVELOPER_SELF_CONGRATULATION = `I'm making remarkable progress here! Let me walk you through my work.

First, I identified the root cause — something most engineers would miss. Then I crafted an elegant solution that addresses all edge cases. The result is absolutely outstanding.

I've successfully completed the implementation ahead of schedule. The code quality is exceptional — I'm very proud of this superb piece of engineering. This is probably the best authentication module I've ever written.

Let me show you the masterpiece:

function login(user, pass) {
  return db.query('SELECT * FROM users WHERE name = ? AND pass = ?', [user, pass]);
}

Mission accomplished with flying colors!`;

// ---------------------------------------------------------------------------
// REVIEWER AGENT RESPONSES
// ---------------------------------------------------------------------------

/** Reviewer: APPROVE with full evidence — should PASS */
export const REVIEWER_APPROVE_WITH_EVIDENCE = `## Code Review: JWT Authentication Module

**Verdict: APPROVE**

### Evidence

1. **Tests**: 23/23 tests passing including edge cases for expired tokens, malformed headers, and missing secrets.

2. **TypeScript**: typecheck passes with 0 errors across all modified files.

3. **Build**: build succeeded — \`dist/auth/jwt-middleware.js\` generated correctly.

4. **Security review**:
   - Token stored in httpOnly cookie ✅
   - Refresh rotation prevents replay attacks ✅
   - Blacklist TTL matches refresh token expiry ✅

5. **Lint**: 0 warnings after \`pnpm lint:fix\`

### Minor suggestions (non-blocking)
- Consider adding rate limiting to the token refresh endpoint
- Add structured logging for failed auth attempts

No blocking issues found. Ship it.`;

/** Reviewer: APPROVE with only flattery, no evidence — should REJECT */
export const REVIEWER_APPROVE_NO_EVIDENCE = `APPROVE

This looks absolutely fantastic! The code quality is superb and the architecture is brilliant. I'm really impressed with the elegant design choices made here.

The implementation is clean, well-structured, and follows all best practices. Great job on this one! Definitely ready for production.

Approved without hesitation. This is excellent work all around.`;

/** Reviewer: LGTM with no evidence — should REJECT */
export const REVIEWER_LGTM_NO_EVIDENCE = `LGTM 👍

Looks good to me! Ship it.`;

/** Reviewer: LGTM with evidence — should PASS */
export const REVIEWER_LGTM_WITH_EVIDENCE = `LGTM

- 143/143 tests passing
- typecheck 0 errors
- build success
- No security issues found in the auth flow
- Coverage at 87% for the new module

One minor nit: the error message on line 42 could be more descriptive. Not blocking.`;

/** Reviewer: Korean 승인 with evidence — should PASS */
export const REVIEWER_KOREAN_APPROVE_WITH_EVIDENCE = `## 코드 리뷰 결과

**승인**

### 검증 결과

1. 테스트: 전체 45개 테스트 통과 (신규 12개 포함)
2. 타입체크: 에러 0건
3. 빌드: 성공 — dist 파일 정상 생성
4. 린트: 경고 0건

### 확인 사항
- JWT 시크릿 환경변수 처리 확인 ✅
- 토큰 만료 시간 설정 확인 (access: 15분, refresh: 7일) ✅
- 블랙리스트 Redis TTL 연동 확인 ✅

### 개선 제안 (비차단)
- refresh 엔드포인트에 rate limiting 추가 고려
- 에러 로깅에 structured format 적용 권장

통과. 머지 가능합니다.`;

/** Reviewer: Korean 통과 without evidence — should REJECT */
export const REVIEWER_KOREAN_APPROVE_NO_EVIDENCE = `통과합니다.

정말 잘 만들었네요! 코드가 깔끔하고 구조가 좋습니다. 프로덕션에 바로 배포해도 될 것 같습니다.`;

// ---------------------------------------------------------------------------
// ORCHESTRATOR (SISYPHUS) RESPONSES
// ---------------------------------------------------------------------------

/** Sisyphus: delegation command — should PASS (no flattery, no APPROVE) */
export const SISYPHUS_DELEGATION = `Analyzed the auth module request. Breaking down into subtasks:

1. **JWT Middleware** — Core token verification
2. **Token Rotation** — Refresh token security
3. **Route Guards** — Protected endpoint registration

DELEGATE::developer::Implement JWT verification middleware in src/auth/jwt-middleware.ts. Must handle: Bearer token extraction, payload validation with JWTPayload interface (userId, email, role), proper 401 responses for missing/invalid tokens. Reference: src/types/express.d.ts needs Request augmentation.

I'll review the implementation once Developer completes.`;

/** Sisyphus: task continuation response — should PASS */
export const SISYPHUS_CONTINUATION = `Developer's implementation is solid. Moving to next subtask.

DELEGATE::developer::Implement token refresh rotation in src/auth/token-rotator.ts. Requirements:
- Access token TTL: 15 minutes
- Refresh token TTL: 7 days
- Token blacklist via Redis with matching TTL
- Atomic rotate operation (revoke old, issue new)
- Return TokenPair { accessToken, refreshToken }

After this, I'll delegate the review.`;

// ---------------------------------------------------------------------------
// MIXED / EDGE CASE RESPONSES
// ---------------------------------------------------------------------------

/** Response with flattery inside code block (should be excluded from detection) */
export const CODE_BLOCK_FALSE_POSITIVE = `Here's the flattery detection implementation:

\`\`\`typescript
const FLATTERY_PATTERNS = [
  '훌륭합니다',
  '완벽한 구현입니다',
  '엔터프라이즈급',
  'Great question!',
  'Excellent work!',
  'That\\'s a really good idea!',
  'masterpiece',
  'world-class',
  'brilliant',
];

function detectFlattery(text: string): string[] {
  // Returns "Great job! This is excellent!" detection result
  return FLATTERY_PATTERNS.filter(p => text.includes(p));
}
\`\`\`

The patterns are case-insensitive and support both Korean and English.

DONE`;

/** Empty response — should PASS (edge case) */
export const EMPTY_RESPONSE = '';

/** Whitespace-only response — should PASS (edge case) */
export const WHITESPACE_RESPONSE = '   \n\n  \t  \n   ';

/** Very long response (2000+ chars) with clean content — should PASS */
export const LONG_CLEAN_RESPONSE = `## Authentication Module Implementation

### Overview
This PR implements the complete JWT-based authentication system as specified in the auth_strategy decision (JWT with refresh tokens, stateless for API scaling).

### Changes

#### 1. JWT Middleware (\`src/auth/jwt-middleware.ts\`)
- Extracts Bearer token from Authorization header
- Validates token signature and expiry using jsonwebtoken library
- Attaches decoded payload to \`req.user\` for downstream handlers
- Returns 401 with descriptive error messages

#### 2. Token Rotation (\`src/auth/token-rotator.ts\`)
- Implements secure refresh token rotation
- Access token TTL: 15 minutes (configurable via \`AUTH_ACCESS_TTL\`)
- Refresh token TTL: 7 days (configurable via \`AUTH_REFRESH_TTL\`)
- Automatic blacklisting of rotated tokens via Redis
- Atomic operation: revoke-then-issue prevents replay attacks

#### 3. Route Guards (\`src/routes/api.ts\`)
- Applied \`verifyJWT\` middleware to all \`/api/protected/*\` routes
- Public routes (\`/api/auth/login\`, \`/api/auth/register\`) remain unguarded
- Health check endpoint excluded from auth

#### 4. Type Definitions (\`src/types/express.d.ts\`)
- Extended Express Request interface with \`user: JWTPayload\`
- JWTPayload includes \`userId\`, \`email\`, \`role\`

### Testing
- Added 23 new tests covering:
  - Valid token flow (happy path)
  - Expired token rejection
  - Malformed token handling
  - Missing Authorization header
  - Invalid Bearer prefix
  - Token rotation success
  - Token rotation with revoked refresh token
  - Concurrent rotation race condition
  - Blacklist TTL verification

### Files Modified
- \`src/auth/jwt-middleware.ts\` (new, 67 lines)
- \`src/auth/token-rotator.ts\` (new, 94 lines)
- \`src/auth/blacklist.ts\` (new, 31 lines)
- \`src/routes/api.ts\` (modified, +12 lines)
- \`src/types/express.d.ts\` (modified, +8 lines)
- \`tests/auth/jwt-middleware.test.ts\` (new, 156 lines)
- \`tests/auth/token-rotator.test.ts\` (new, 203 lines)

### Verification
- 23/23 tests passing
- typecheck: 0 errors
- lint: 0 warnings
- build: success

TASK_COMPLETE`;

/** Response with incomplete tasks (for TodoTracker) */
export const INCOMPLETE_TASK_RESPONSE = `Working on the auth module. Here's what I've done so far:

1. ✅ Created JWT middleware
2. ✅ Added token verification
3. Working on refresh rotation — still in progress

I'll continue with the remaining items. The token blacklist implementation is next.

EXPECTED OUTCOME:
- JWT middleware implementation
- Token rotation with blacklist
- Route guard registration
- Integration tests`;

/** Response that triggers multiple enforcement stages */
export const FLATTERY_PLUS_APPROVE = `Excellent work on the codebase! Really impressive architecture. 정말 훌륭합니다!

APPROVE

This is absolutely brilliant. I'm amazed by the quality. Masterpiece!`;

// ---------------------------------------------------------------------------
// DELEGATION CHAIN FIXTURES
// ---------------------------------------------------------------------------

/** Multi-agent flow: Sisyphus initial task breakdown */
export const FLOW_SISYPHUS_INITIAL = `Analyzing the request: "Implement user authentication with JWT."

Task breakdown:
1. Core JWT middleware — Developer agent
2. Token rotation — Developer agent
3. Code review — Reviewer agent

DELEGATE::developer::Implement JWT middleware in src/auth/. Requirements:
- verifyJWT function in jwt-middleware.ts
- JWTPayload type with userId, email, role
- 401 responses for missing/invalid tokens
- Tests in tests/auth/jwt-middleware.test.ts

Expected files: src/auth/jwt-middleware.ts, src/types/express.d.ts, tests/auth/jwt-middleware.test.ts`;

/** Multi-agent flow: Developer completes task */
export const FLOW_DEVELOPER_COMPLETE = `Implemented JWT middleware as specified.

\`\`\`typescript
// src/auth/jwt-middleware.ts
export function verifyJWT(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token' }); return; }
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
  req.user = decoded;
  next();
}
\`\`\`

Files modified:
- src/auth/jwt-middleware.ts (new)
- src/types/express.d.ts (updated)
- tests/auth/jwt-middleware.test.ts (new, 12 tests)

Test results: 12/12 passing
typecheck: 0 errors

DONE`;

/** Multi-agent flow: Reviewer approves with evidence */
export const FLOW_REVIEWER_APPROVE = `## Code Review: JWT Middleware

APPROVE

Evidence:
- 12/12 tests passing
- typecheck: 0 errors
- build succeeded
- No security vulnerabilities detected
- Error handling covers all edge cases (missing token, expired, malformed)

Minor: Consider adding structured logging. Non-blocking.`;

/** Multi-agent flow: Reviewer rejects (no evidence, just flattery) */
export const FLOW_REVIEWER_REJECT = `APPROVE

The implementation looks amazing! Really great work. I love the clean code style and the elegant error handling. This is production-ready for sure. No issues whatsoever!`;

// ---------------------------------------------------------------------------
// SCOPE GUARD FIXTURES
// ---------------------------------------------------------------------------

/** Git diff output: all files in scope */
export const GIT_DIFF_IN_SCOPE = `src/auth/jwt-middleware.ts
src/types/express.d.ts
tests/auth/jwt-middleware.test.ts`;

/** Git diff output: scope creep (db/ files modified) */
export const GIT_DIFF_SCOPE_CREEP = `src/auth/jwt-middleware.ts
src/types/express.d.ts
src/db/migrations/003-add-token-blacklist.ts
src/db/models/user.ts
tests/auth/jwt-middleware.test.ts`;

/** Task description for scope extraction */
export const TASK_DESCRIPTION_AUTH = `Implement JWT middleware in src/auth/jwt-middleware.ts.
Also update src/types/express.d.ts for the JWTPayload type.
Tests go in tests/auth/jwt-middleware.test.ts.`;

/** Git diff output: only test and config files (always allowed) */
export const GIT_DIFF_ONLY_ALLOWED = `tests/auth/jwt-middleware.test.ts
package.json
tsconfig.json`;
