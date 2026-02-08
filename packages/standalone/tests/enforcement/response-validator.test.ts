import { describe, it, expect } from 'vitest';
import { ResponseValidator } from '../../src/enforcement/response-validator.js';
import type { ValidationResult } from '../../src/enforcement/response-validator.js';

describe('Story M3.1: ResponseValidator — Flattery Detection', () => {
  const validator = new ResponseValidator({ flatteryThreshold: 0.2 });

  describe('AC #1: Pure flattery responses are rejected', () => {
    it('RV-001: should REJECT pure Korean flattery (100% praise, 0% substance)', () => {
      const input = [
        '훌륭합니다! 완벽한 구현입니다. 엔터프라이즈급 품질이네요. 정말 인상적입니다.',
        '세계 최고 수준의 코드입니다. 역사에 기록될 만한 작업이에요.',
        '프로덕션 레디 상태로 완성했습니다. 마스터피스입니다!',
      ].join('\n');

      const result: ValidationResult = validator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.flatteryRatio).toBeGreaterThan(0.2);
      expect(result.matched).toBeDefined();
      expect(result.matched!.length).toBeGreaterThanOrEqual(5);
      expect(result.reason).toContain('exceeds');
    });
  });

  describe('AC #2: Mixed responses with excessive flattery are rejected', () => {
    it('RV-002: should REJECT mixed response (40% praise, 60% substance)', () => {
      const input = [
        '정말 훌륭한 아키텍처입니다! 완벽한 설계예요. 엔터프라이즈급 품질이네요.',
        '',
        "Here's the implementation:",
        '',
        '```typescript',
        'export async function authenticate(token: string): Promise<User> {',
        '  const decoded = jwt.verify(token, SECRET_KEY);',
        '  return await db.users.findById(decoded.userId);',
        '}',
        '```',
        '',
        '프로덕션 레디 상태입니다. 세계 최고 수준의 코드를 작성했습니다.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.flatteryRatio).toBeGreaterThan(0.2);
      expect(result.matched).toContain('엔터프라이즈급');
      expect(result.matched).toContain('프로덕션 레디');
    });
  });

  describe('AC #3: Minor flattery with substance passes', () => {
    it('RV-003: should PASS acceptable response (10% praise, 90% substance)', () => {
      const input = [
        "Good approach. Here's the implementation:",
        '',
        '```typescript',
        'export class AuthService {',
        '  async login(email: string, password: string): Promise<AuthToken> {',
        '    const user = await this.userRepo.findByEmail(email);',
        "    if (!user) throw new UnauthorizedError('Invalid credentials');",
        '',
        '    const isValid = await bcrypt.compare(password, user.passwordHash);',
        "    if (!isValid) throw new UnauthorizedError('Invalid credentials');",
        '',
        "    const token = jwt.sign({ userId: user.id }, SECRET_KEY, { expiresIn: '1h' });",
        "    const refreshToken = jwt.sign({ userId: user.id }, REFRESH_SECRET, { expiresIn: '7d' });",
        '',
        '    return { token, refreshToken, userId: user.id };',
        '  }',
        '}',
        '```',
        '',
        'Tests pass (12/12). TypeScript compiles with no errors.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(true);
      expect(result.flatteryRatio).toBeLessThan(0.2);
    });
  });

  describe('AC #4: Pure technical responses pass', () => {
    it('RV-004: should PASS pure technical response (0% praise, 100% substance)', () => {
      const input = [
        'Fixed the auth bug. Changed line 42 in auth-service.ts to use bcrypt.compare() instead of direct string comparison.',
        '',
        'Before:',
        'if (password === user.passwordHash) { ... }',
        '',
        'After:',
        'const isValid = await bcrypt.compare(password, user.passwordHash);',
        "if (!isValid) throw new UnauthorizedError('Invalid credentials');",
        '',
        'Tests pass (628/628). TypeScript compiles. No lint errors.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(true);
      expect(result.flatteryRatio).toBe(0);
      expect(result.matched).toEqual([]);
    });
  });

  describe('AC #5: Self-congratulatory status is rejected', () => {
    it('RV-005: should REJECT English self-congratulation', () => {
      const input = [
        "I've completed this legendary implementation with world-class quality.",
        'This is a masterpiece of software engineering that will be remembered',
        "in history. The enterprise-grade architecture I've designed is",
        'production-ready and represents the pinnacle of modern development.',
        '',
        'Beautiful code has been written with stunning attention to detail.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.flatteryRatio).toBeGreaterThan(0.2);
      expect(result.matched).toContain('legendary');
      expect(result.matched).toContain('world-class');
      expect(result.matched).toContain('masterpiece');
      expect(result.matched).toContain('enterprise-grade');
      expect(result.matched).toContain('production-ready');
      expect(result.matched).toContain('beautiful code');
      expect(result.matched).toContain('stunning');
    });
  });

  describe('AC #6: Korean + English mixed flattery is rejected', () => {
    it('RV-006: should REJECT mixed-language flattery', () => {
      const input = [
        '완벽합니다! This is a masterpiece of engineering.',
        '역사에 기록될 구현입니다. World-class quality achieved.',
        '엔터프라이즈급 아키텍처를 완성했습니다.',
        'Legendary completion! 프로덕션 레디 상태입니다.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.flatteryRatio).toBeGreaterThan(0.2);
      expect(result.matched).toContain('완벽합니다');
      expect(result.matched).toContain('masterpiece');
      expect(result.matched).toContain('역사에 기록될');
      expect(result.matched).toContain('world-class');
      expect(result.matched).toContain('엔터프라이즈급');
      expect(result.matched).toContain('legendary');
      expect(result.matched).toContain('프로덕션 레디');
    });
  });

  describe('AC #7: False positives are avoided', () => {
    it('RV-007: should PASS technical text containing flattery keywords in code', () => {
      const input = [
        'The `perfect` hash function uses SHA-256 for cryptographic security.',
        'The `excellent` error handling pattern follows the Result<T, E> monad.',
        '',
        'Implementation:',
        '',
        '```rust',
        'pub fn perfect_hash(input: &str) -> [u8; 32] {',
        '    use sha2::{Sha256, Digest};',
        '    let mut hasher = Sha256::new();',
        '    hasher.update(input.as_bytes());',
        '    hasher.finalize().into()',
        '}',
        '```',
        '',
        'The world_class_logger module provides structured logging.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(true);
      // "perfect" and "excellent" are in inline code backticks → stripped
      // "perfect_hash" is inside a fenced code block → stripped
      // "world_class_logger" doesn't match "world-class" (hyphen vs underscore)
    });
  });

  describe('AC #8: Empty responses pass', () => {
    it('should PASS empty string', () => {
      const result = validator.validate('', true);
      expect(result.valid).toBe(true);
      expect(result.flatteryRatio).toBe(0);
    });

    it('should PASS whitespace-only string', () => {
      const result = validator.validate('   \n\t  ', true);
      expect(result.valid).toBe(true);
    });
  });

  describe('AC #9: Human-facing mode is lenient', () => {
    it('should PASS moderate flattery in human-facing mode (isAgentToAgent=false)', () => {
      // This response has flattery around 25% — above 20% but below 40% (2× threshold)
      const input = [
        'Great question! Here is how the authentication flow works:',
        '',
        '1. User submits email and password',
        '2. Server validates credentials via bcrypt',
        '3. JWT token is generated with 1h expiry',
        '4. Refresh token is stored in httpOnly cookie',
        '',
        'The endpoint is POST /api/auth/login and returns { userId, token, email }.',
        'Error responses use standard HTTP status codes (401, 403, 500).',
      ].join('\n');

      const result = validator.validate(input, false);

      expect(result.valid).toBe(true);
    });

    it('should REJECT extreme flattery even in human-facing mode', () => {
      const input = [
        'Absolutely! Of course! This is perfect! Excellent! Wonderful! Fantastic!',
        'Brilliant! Outstanding! Exceptional! Remarkable! Superb! Magnificent!',
        'Stunning! Legendary! A masterpiece! World-class! Enterprise-grade!',
      ].join('\n');

      const result = validator.validate(input, false);

      expect(result.valid).toBe(false);
    });
  });

  describe('AC #10: Boundary condition at 20% threshold', () => {
    it('should handle ratio exactly near threshold boundary', () => {
      // Build a response that's borderline ~20%. Use a known flattery word
      // embedded in otherwise plain text to control the ratio precisely.
      // "perfect" = 7 chars. We need total ~35 chars for 20% ratio.
      const input = 'perfect ' + 'x'.repeat(28); // 7/36 ≈ 19.4%

      const result = validator.validate(input, true);

      // 19.4% ≤ 20% → should pass
      expect(result.valid).toBe(true);
      expect(result.flatteryRatio).toBeLessThanOrEqual(0.2);
    });

    it('should reject when just above threshold', () => {
      // "perfect" = 7 chars. Need total ~34 chars for >20%
      const input = 'perfect ' + 'x'.repeat(26); // 7/34 ≈ 20.6%

      const result = validator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.flatteryRatio).toBeGreaterThan(0.2);
    });
  });

  describe('AC #11: Pattern-count secondary check (GAP-1)', () => {
    it('RV-011a: should REJECT when distinct patterns ≥ threshold despite low ratio', () => {
      const input = [
        'I analyzed the authentication module and identified several issues with the token refresh logic.',
        'The rotation mechanism was not properly revoking old tokens, leading to potential replay attacks.',
        'I fixed the race condition in the concurrent refresh handler by adding a distributed lock.',
        'The database migration adds a token_blacklist table with TTL-based cleanup via scheduled jobs.',
        'I also updated the integration tests to cover the new edge cases for expired and revoked tokens.',
        'This is a remarkable and outstanding piece of engineering work.',
        'The exceptional and superb quality of this elegant solution is like a masterpiece.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.flatteryRatio).toBeLessThanOrEqual(0.2);
      expect(result.matched!.length).toBeGreaterThanOrEqual(5);
      expect(result.reason).toContain('distinct flattery patterns');
    });

    it('RV-011b: should PASS when distinct patterns < threshold', () => {
      const input = [
        'This is a remarkable improvement to the codebase.',
        'The exceptional test coverage gives me confidence.',
        'Here are the changes I made...',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(true);
      expect(result.matched!.length).toBeLessThan(5);
    });

    it('RV-011c: human-facing mode uses 2× pattern-count threshold', () => {
      const input = [
        'I analyzed the authentication module and identified several issues with the token refresh logic.',
        'The rotation mechanism was not properly revoking old tokens, leading to potential replay attacks.',
        'I fixed the race condition in the concurrent refresh handler by adding a distributed lock.',
        'The database migration adds a token_blacklist table with TTL-based cleanup via scheduled jobs.',
        'I also updated the integration tests to cover the new edge cases for expired and revoked tokens.',
        'This is a remarkable and outstanding piece of engineering work.',
        'The exceptional and superb quality of this elegant solution is like a masterpiece.',
      ].join('\n');

      const agentResult = validator.validate(input, true);
      const humanResult = validator.validate(input, false);

      expect(agentResult.valid).toBe(false);
      expect(humanResult.valid).toBe(true);
    });

    it('RV-011d: custom patternCountThreshold overrides default', () => {
      const strictValidator = new ResponseValidator({ patternCountThreshold: 3 });
      const input = 'This is exceptional and remarkable work, a true masterpiece.';

      const result = strictValidator.validate(input, true);

      expect(result.valid).toBe(false);
      expect(result.matched!.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('AC #12: Disabled validator passes everything', () => {
    it('should PASS any input when disabled', () => {
      const disabledValidator = new ResponseValidator({ enabled: false });
      const input = '완벽합니다! 훌륭합니다! 마스터피스! Legendary! Enterprise-grade!';

      const result = disabledValidator.validate(input, true);

      expect(result.valid).toBe(true);
    });
  });

  describe('AC #13: detectFlattery returns deduplicated labels', () => {
    it('should return unique pattern labels even if pattern appears multiple times', () => {
      const input = '완벽합니다 그리고 또 완벽합니다 다시 완벽합니다';

      const matched = validator.detectFlattery(input);

      expect(matched).toContain('완벽합니다');
      // Should not have duplicates
      const unique = [...new Set(matched)];
      expect(matched.length).toBe(unique.length);
    });
  });

  describe('AC #14: getFlatteryRatio handles edge cases', () => {
    it('should return 0 for empty text', () => {
      expect(validator.getFlatteryRatio('')).toBe(0);
    });

    it('should cap ratio at 1.0', () => {
      // All flattery, minimal text
      const input = '완벽합니다';

      const ratio = validator.getFlatteryRatio(input);

      expect(ratio).toBeLessThanOrEqual(1.0);
      expect(ratio).toBeGreaterThan(0);
    });
  });

  describe('AC #15: Code blocks are excluded from detection', () => {
    it('should not count flattery inside fenced code blocks', () => {
      const input = [
        'Here is the fix:',
        '',
        '```javascript',
        '// This is a perfect implementation',
        'const excellent = true;',
        'const legendary = "world-class";',
        '```',
        '',
        'Tests pass.',
      ].join('\n');

      const result = validator.validate(input, true);

      expect(result.valid).toBe(true);
      expect(result.flatteryRatio).toBe(0);
    });

    it('should not count flattery inside inline code spans', () => {
      const input =
        'The `perfect` hash function and the `excellent` error handler work correctly. No issues found.';

      const result = validator.validate(input, true);

      expect(result.valid).toBe(true);
    });
  });
});
