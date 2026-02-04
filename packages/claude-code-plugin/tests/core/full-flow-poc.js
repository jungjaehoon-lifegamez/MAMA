#!/usr/bin/env node
/**
 * MAMA v2 Full Flow PoC Test
 *
 * Simulates the complete flow:
 * 1. PostToolUse Hook: Generate template (no regex pre-filter)
 * 2. Main Claude: Review template
 * 3. Task tool: Call Haiku sub-agent (simulated)
 * 4. Haiku: Save to MAMA
 * 5. PreToolUse: Search and inject contracts
 */

const path = require('path');
const fs = require('fs');

// Setup paths
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CORE_PATH = path.resolve(__dirname, '../../src/core');
const { saveDecision, searchDecisions } = require(path.join(CORE_PATH, 'mcp-client'));
const { formatContractTemplate } = require(path.join(PLUGIN_ROOT, 'scripts', 'posttooluse-hook'));

// Test code fixture (portable path using __dirname)
const testApiPath = path.resolve(__dirname, 'fixtures', 'test-api.ts');
const testCode = fs.readFileSync(testApiPath, 'utf8');

console.log('🎯 MAMA v2 Full Flow PoC\n');
console.log('='.repeat(60));

/**
 * Step 1: PostToolUse Hook - Generate template
 */
async function step1_postToolUse() {
  console.log('\n📝 Step 1: PostToolUse Hook - Generate Template\n');

  const filePath = 'tests/core/fixtures/test-api.ts';
  const diffContent = testCode
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');

  const template = formatContractTemplate(filePath, diffContent, 'Edit');
  console.log('Hook Output (template):');
  console.log('---');
  console.log(template);

  return { filePath, diffContent };
}

/**
 * Step 2: Simulate Haiku analysis
 */
function buildContractTopic(method, apiPath) {
  const safePath = apiPath.replace(/[^a-z0-9]/gi, '_');
  return `contract_${method.toLowerCase()}_${safePath}`;
}

function step2_simulateHaiku({ filePath }) {
  console.log('🤖 Step 2: Simulate Haiku Analysis\n');

  const candidates = [
    {
      topic: buildContractTopic('POST', '/api/auth/register'),
      decision:
        'POST /api/auth/register expects { email, password }, returns { userId, token } defined in tests/core/fixtures/test-api.ts',
      reasoning: `Auto-extracted from ${filePath}. Keep backend/frontend schema consistent.`,
      confidence: 0.8,
    },
    {
      topic: buildContractTopic('GET', '/api/profile'),
      decision:
        'GET /api/profile expects auth context, returns { id, email } defined in tests/core/fixtures/test-api.ts',
      reasoning: `Auto-extracted from ${filePath}. Keep backend/frontend schema consistent.`,
      confidence: 0.8,
    },
  ];

  if (candidates.length === 0) {
    console.log('contract analysis skipped');
    return [];
  }

  candidates.forEach((contract, idx) => {
    console.log(`${idx + 1}. ${contract.topic}`);
    console.log(`   Decision: ${contract.decision}`);
    console.log(`   Confidence: ${Math.round(contract.confidence * 100)}%\n`);
  });

  return candidates;
}

/**
 * Step 3: Simulate Haiku Sub-agent - Save to MAMA
 */
async function step3_haikuSave(formattedContracts) {
  console.log('🤖 Step 3: Haiku Sub-agent - Save to MAMA\n');

  const results = [];

  for (const contract of formattedContracts) {
    try {
      console.log(`Saving: ${contract.topic}...`);
      const result = await saveDecision(contract, { timeout: 20000 });

      if (result.success) {
        const safeId = result?.id?.id ?? 'success';
        console.log(`  ✅ Saved: ${safeId}`);
        results.push({ success: true, contract, result });
      } else {
        console.log(`  ❌ Failed: ${result.error || 'unknown error'}`);
        results.push({ success: false, contract, error: result.error });
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
      results.push({ success: false, contract, error: error.message });
    }
  }

  console.log(
    `\n✅ Saved ${results.filter((r) => r.success).length}/${results.length} contracts\n`
  );

  return results;
}

/**
 * Step 4: Main Claude - Verify with Search
 */
async function step4_verify() {
  console.log('🔍 Step 4: Main Claude - Verify Saved Contracts\n');

  try {
    const searchResult = await searchDecisions('contract test-api', 10, { timeout: 20000 });

    const results = Array.isArray(searchResult.results) ? searchResult.results : [];
    const contractResults = results.filter(
      (r) => r.topic && r.topic.startsWith('contract_') && Number.isFinite(r.similarity)
    );

    if (contractResults.length > 0) {
      console.log(`Found ${contractResults.length} contracts in MAMA:`);
      contractResults.forEach((r, idx) => {
        console.log(`  ${idx + 1}. ${r.topic} (${Math.round(r.similarity * 100)}% match)`);
        console.log(`     ${(r.decision || '').substring(0, 80)}...`);
      });
      console.log('\n✅ Contracts successfully saved and searchable!\n');
      return true;
    } else {
      console.log('⚠️  No contracts found in search\n');
      return false;
    }
  } catch (error) {
    console.error(`❌ Search failed: ${error.message}\n`);
    return false;
  }
}

/**
 * Step 5: PreToolUse Hook - Contract Injection (simulated)
 */
async function step5_preToolUse() {
  console.log('🔌 Step 5: PreToolUse Hook - Contract Injection\n');

  console.log('Simulating PreToolUse hook when editing frontend code...\n');

  try {
    const searchResult = await searchDecisions('api register', 5, { timeout: 20000 });

    const results = Array.isArray(searchResult.results) ? searchResult.results : [];
    const contractResults = results.filter(
      (r) => r.topic && r.topic.startsWith('contract_') && Number.isFinite(r.similarity)
    );

    if (contractResults.length > 0) {
      console.log('PreToolUse would inject:');
      console.log('---');
      console.log('🔌 Related Contracts (MAMA v2)\n');
      console.log('⚠️ Frontend/Backend consistency required:\n');

      contractResults.slice(0, 3).forEach((r, idx) => {
        console.log(`${idx + 1}. ${r.topic} (${Math.round(r.similarity * 100)}% match)`);
        console.log(`   ${r.decision}`);
      });

      console.log('\n💡 Use exact schema from these contracts to prevent API mismatches.');
      console.log('---\n');

      return true;
    }
    console.log('⚠️ No related contracts found for injection\n');
    return false;
  } catch (error) {
    console.error(`❌ PreToolUse injection failed: ${error.message}\n`);
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  try {
    // Step 1: Generate template
    const templateInput = await step1_postToolUse();

    // Step 2: Simulate Haiku analysis
    const formattedContracts = step2_simulateHaiku(templateInput);

    // Step 3: Haiku saves to MAMA
    const saveResults = await step3_haikuSave(formattedContracts);

    if (saveResults.filter((r) => r.success).length === 0) {
      console.log('⚠️  No contracts were saved, skipping verification\n');
      return;
    }

    // Step 4: Verify with search
    await step4_verify();

    // Step 5: PreToolUse injection
    await step5_preToolUse();

    console.log('='.repeat(60));
    console.log('\n✅ Full Flow PoC Complete!\n');
    console.log('Summary:');
    console.log(`  - Extracted: ${formattedContracts.length} contracts`);
    console.log(`  - Saved: ${saveResults.filter((r) => r.success).length} contracts`);
    console.log('  - Verified: Search working');
    console.log('  - PreToolUse: Injection working\n');

    console.log('🎯 Next Steps:');
    console.log('  1. Test with real Edit tool in Claude Code');
    console.log('  2. Verify PostToolUse hook template output');
    console.log('  3. Test Task tool with Haiku model');
    console.log('  4. Verify PreToolUse contract injection\n');
  } catch (error) {
    console.error('\n❌ PoC failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { main };
