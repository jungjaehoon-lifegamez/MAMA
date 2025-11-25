/**
 * Tests for Transparency Banner Module
 *
 * Story M2.4: Transparency Banner
 * Tests FR25-FR29: Tier status display, feature visibility, fix instructions, impact quantification, transition logging
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Story M2.4: Transparency Banner', () => {
  let banner;
  const TIER_LOG_FILE = path.join(__dirname, '../../.mama-tier-transitions.log');

  beforeEach(async () => {
    // Clean up tier log before each test
    if (fs.existsSync(TIER_LOG_FILE)) {
      fs.unlinkSync(TIER_LOG_FILE);
    }

    // Import module
    banner = await import('../../src/mama/transparency-banner.js');
  });

  afterEach(() => {
    // Clean up tier log after each test
    if (fs.existsSync(TIER_LOG_FILE)) {
      fs.unlinkSync(TIER_LOG_FILE);
    }
  });

  describe('Module Structure', () => {
    it('should export required functions', () => {
      expect(banner).toHaveProperty('formatTransparencyBanner');
      expect(banner).toHaveProperty('formatFeatureStatus');
      expect(banner).toHaveProperty('formatFixInstructions');
      expect(banner).toHaveProperty('logTierTransition');
      expect(banner).toHaveProperty('getFeatureStatus');
      expect(banner).toHaveProperty('getFixInstructions');
      expect(banner).toHaveProperty('getTierTransitionHistory');
      expect(banner).toHaveProperty('FEATURE_STATUS');
      expect(banner).toHaveProperty('FIX_INSTRUCTIONS');

      expect(typeof banner.formatTransparencyBanner).toBe('function');
      expect(typeof banner.logTierTransition).toBe('function');
    });

    it('should define feature status matrix', () => {
      expect(banner.FEATURE_STATUS).toHaveProperty('tier1');
      expect(banner.FEATURE_STATUS).toHaveProperty('tier2');
      expect(banner.FEATURE_STATUS).toHaveProperty('tier3');

      expect(banner.FEATURE_STATUS.tier1.vectorSearch).toBe(true);
      expect(banner.FEATURE_STATUS.tier2.vectorSearch).toBe(false);
      expect(banner.FEATURE_STATUS.tier3.vectorSearch).toBe(false);
    });

    it('should define fix instructions', () => {
      expect(banner.FIX_INSTRUCTIONS).toHaveProperty('tier2');
      expect(banner.FIX_INSTRUCTIONS).toHaveProperty('tier3');

      expect(banner.FIX_INSTRUCTIONS.tier2).toHaveProperty('title');
      expect(banner.FIX_INSTRUCTIONS.tier2).toHaveProperty('steps');
      expect(banner.FIX_INSTRUCTIONS.tier2).toHaveProperty('impact');
    });
  });

  describe('FR25: Tier Status Display', () => {
    it('should display Tier 1 badge', () => {
      const tierInfo = { tier: 1, reason: 'Full features' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 5, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('🟢 Tier 1');
      expect(result).toContain('TestHook');
    });

    it('should display Tier 2 badge', () => {
      const tierInfo = { tier: 2, reason: 'Embeddings unavailable' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 3, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('🟡 Tier 2');
    });

    it('should display Tier 3 badge', () => {
      const tierInfo = { tier: 3, reason: 'MAMA disabled' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 0, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('🔴 Tier 3');
    });

    it('should include reason in banner', () => {
      const tierInfo = { tier: 1, reason: 'Full MAMA features available' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 5, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('Full MAMA features available');
    });
  });

  describe('FR26: Feature Status Display', () => {
    it('should show all features active for Tier 1', () => {
      const status = banner.formatFeatureStatus(1);

      expect(status).toContain('Vector Search: ✓');
      expect(status).toContain('Graph: ✓');
      expect(status).toContain('Keyword: ✓');
    });

    it('should show vector search degraded for Tier 2', () => {
      const status = banner.formatFeatureStatus(2);

      expect(status).toContain('Vector Search: ✗');
      expect(status).toContain('Graph: ✓');
      expect(status).toContain('Keyword: ✓');
    });

    it('should show all features degraded for Tier 3', () => {
      const status = banner.formatFeatureStatus(3);

      expect(status).toContain('Vector Search: ✗');
      expect(status).toContain('Graph: ✗');
      expect(status).toContain('Keyword: ✗');
    });

    it('should include feature status in banner', () => {
      const tierInfo = { tier: 2, reason: 'Degraded' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 3, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('Vector Search:');
      expect(result).toContain('Graph:');
      expect(result).toContain('Keyword:');
    });
  });

  describe('FR27: Fix Instructions', () => {
    it('should provide fix instructions for Tier 2', () => {
      const instructions = banner.formatFixInstructions(2);

      expect(instructions).toContain('Embedding Model Unavailable');
      expect(instructions).toContain('Install Transformers.js');
      expect(instructions).toContain('npm install @xenova/transformers');
      expect(instructions).toContain('~/.mama/config.json');
    });

    it('should provide fix instructions for Tier 3', () => {
      const instructions = banner.formatFixInstructions(3);

      expect(instructions).toContain('MAMA Disabled');
      expect(instructions).toContain('MAMA_DISABLE_HOOKS');
      expect(instructions).toContain('vectorSearchEnabled');
    });

    it('should not provide fix instructions for Tier 1', () => {
      const instructions = banner.formatFixInstructions(1);

      expect(instructions).toBe('');
    });

    it('should include fix instructions in banner for degraded tiers', () => {
      const tierInfo = { tier: 2, reason: 'Degraded' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 3, 'TestHook', {
        showFixInstructions: true,
        logTransition: false,
      });

      expect(result).toContain('Embedding Model Unavailable');
      expect(result).toContain('Install Transformers.js');
    });

    it('should omit fix instructions when disabled', () => {
      const tierInfo = { tier: 2, reason: 'Degraded' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 3, 'TestHook', {
        showFixInstructions: false,
        logTransition: false,
      });

      expect(result).not.toContain('Embedding Model Unavailable');
      expect(result).not.toContain('Install Transformers.js');
    });
  });

  describe('FR28: Degradation Impact Quantification', () => {
    it('should quantify Tier 1 impact (0% drop)', () => {
      const features = banner.getFeatureStatus(1);

      expect(features.accuracyDrop).toBe(0);
    });

    it('should quantify Tier 2 impact (30% drop)', () => {
      const features = banner.getFeatureStatus(2);

      expect(features.accuracyDrop).toBe(30);
    });

    it('should quantify Tier 3 impact (100% drop)', () => {
      const features = banner.getFeatureStatus(3);

      expect(features.accuracyDrop).toBe(100);
    });

    it('should display accuracy drop in banner for Tier 2', () => {
      const tierInfo = { tier: 2, reason: 'Degraded' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 3, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('30% accuracy drop');
    });

    it('should display accuracy drop in banner for Tier 3', () => {
      const tierInfo = { tier: 3, reason: 'Disabled' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 0, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('100% accuracy drop');
    });

    it('should not display accuracy drop for Tier 1', () => {
      const tierInfo = { tier: 1, reason: 'Full features' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 5, 'TestHook', {
        logTransition: false,
      });

      expect(result).not.toContain('accuracy drop');
    });
  });

  describe('FR29: Tier Transition Logging', () => {
    it('should log tier transitions to file', () => {
      banner.logTierTransition(1, 2, 'Embeddings unavailable');

      expect(fs.existsSync(TIER_LOG_FILE)).toBe(true);

      const content = fs.readFileSync(TIER_LOG_FILE, 'utf8');
      expect(content).toContain('Tier 1 → Tier 2');
      expect(content).toContain('Embeddings unavailable');
    });

    it('should log transitions with timestamp', () => {
      banner.logTierTransition(1, 2, 'Test transition');

      const content = fs.readFileSync(TIER_LOG_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('transition');
      expect(entry).toHaveProperty('reason');
      expect(entry).toHaveProperty('feature_impact');
    });

    it('should log feature impact with transition', () => {
      banner.logTierTransition(1, 2, 'Test transition');

      const content = fs.readFileSync(TIER_LOG_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.feature_impact).toHaveProperty('vectorSearch');
      expect(entry.feature_impact).toHaveProperty('accuracyDrop');
      expect(entry.feature_impact.vectorSearch).toBe(false);
      expect(entry.feature_impact.accuracyDrop).toBe(30);
    });

    it('should retrieve tier transition history', () => {
      banner.logTierTransition(1, 2, 'First transition');
      banner.logTierTransition(2, 1, 'Second transition');
      banner.logTierTransition(1, 3, 'Third transition');

      const history = banner.getTierTransitionHistory(10);

      expect(history).toHaveLength(3);
      expect(history[0].transition).toContain('Tier 1 → Tier 3');
      expect(history[2].transition).toContain('Tier 1 → Tier 2');
    });

    it('should limit transition history', () => {
      for (let i = 1; i <= 20; i++) {
        banner.logTierTransition((i % 3) + 1, ((i + 1) % 3) + 1, `Transition ${i}`);
      }

      const history = banner.getTierTransitionHistory(5);

      expect(history).toHaveLength(5);
    });
  });

  describe('Performance Indicators', () => {
    it('should show success indicator for fast operations', () => {
      const tierInfo = { tier: 1, reason: 'Full features' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 5, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('✓ 100ms');
    });

    it('should show warning for slow operations', () => {
      const tierInfo = { tier: 1, reason: 'Full features' };
      const result = banner.formatTransparencyBanner(tierInfo, 600, 5, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('⚠️ 600ms');
      expect(result).toContain('exceeded 500ms target');
    });

    it('should include result count', () => {
      const tierInfo = { tier: 1, reason: 'Full features' };
      const result = banner.formatTransparencyBanner(tierInfo, 100, 5, 'TestHook', {
        logTransition: false,
      });

      expect(result).toContain('5 decisions');
    });
  });

  describe('Integration', () => {
    it('should format complete banner with all elements', () => {
      const tierInfo = { tier: 2, reason: 'Embeddings unavailable' };
      const result = banner.formatTransparencyBanner(tierInfo, 150, 3, 'UserPromptSubmit', {
        showFixInstructions: true,
        logTransition: false,
      });

      // FR25: Tier status
      expect(result).toContain('🟡 Tier 2');

      // FR26: Feature status
      expect(result).toContain('Vector Search: ✗');

      // FR27: Fix instructions
      expect(result).toContain('Embedding Model Unavailable');

      // FR28: Impact
      expect(result).toContain('30% accuracy drop');

      // Performance
      expect(result).toContain('150ms');
      expect(result).toContain('3 decisions');

      // Hook name
      expect(result).toContain('UserPromptSubmit');
    });

    it('should handle automatic tier transition logging', () => {
      const tierInfo1 = { tier: 1, reason: 'Full features' };
      const tierInfo2 = { tier: 2, reason: 'Degraded' };

      // First call - initial state
      banner.formatTransparencyBanner(tierInfo1, 100, 5, 'TestHook', { logTransition: true });

      // Second call - transition
      banner.formatTransparencyBanner(tierInfo2, 100, 3, 'TestHook', { logTransition: true });

      const history = banner.getTierTransitionHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
    });
  });
});
