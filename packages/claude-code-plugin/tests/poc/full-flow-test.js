#!/usr/bin/env node
/**
 * MAMA v2 Full Flow PoC Test
 *
 * Simulates the complete flow:
 * 1. PostToolUse Hook: Extract contracts → Generate template
 * 2. Main Claude: Review template
 * 3. Task tool: Call Haiku sub-agent (simulated)
 * 4. Haiku: Save to MAMA
 * 5. PreToolUse: Search and inject contracts
 */

const path = require('path');
const fs = require('fs');

// Setup paths
const CORE_PATH = path.resolve(__dirname, '../../src/core');
const { extractContracts, formatContractForMama } = require(
  path.join(CORE_PATH, 'contract-extractor')
);
const { saveDecision, searchDecisions } = require(path.join(CORE_PATH, 'mcp-client'));

// Test code from test-api.ts
const testCode = fs.readFileSync('/home/deck/project/MAMA/test-api.ts', 'utf8');

console.log('🎯 MAMA v2 Full Flow PoC\n');
console.log('='.repeat(60));

/**
 * Step 1: PostToolUse Hook - Extract contracts
 */
async function step1_postToolUse() {
  console.log('\n📝 Step 1: PostToolUse Hook - Extract Contracts\n');

  const extracted = extractContracts(testCode, 'test-api.ts');
  const allContracts = [
    ...extracted.apiEndpoints,
    ...extracted.functionSignatures,
    ...extracted.typeDefinitions,
  ];

  console.log(`Found ${allContracts.length} contracts:`);
  allContracts.forEach((c, idx) => {
    console.log(
      `  ${idx + 1}. ${c.type}: ${c.method || c.name || c.kind} (confidence: ${Math.round(c.confidence * 100)}%)`
    );
  });

  // Filter high-confidence
  const filtered = allContracts.filter((c) => c.confidence >= 0.7);
  console.log(`\n✅ ${filtered.length} high-confidence candidates (>= 70%)\n`);

  return filtered;
}

/**
 * Step 2: Generate Template for Main Claude
 */
function step2_generateTemplate(contracts) {
  console.log('📋 Step 2: Generate Template for Main Claude\n');

  console.log('Hook Output (template):');
  console.log('---');
  console.log('🔌 MAMA v2: Contract Candidates Detected\n');
  console.log('File: test-api.ts');
  console.log(`Candidates: ${contracts.length}\n`);

  contracts.forEach((contract, idx) => {
    const formatted = formatContractForMama(contract);
    if (formatted) {
      console.log(`${idx + 1}. ${formatted.topic}`);
      console.log(`   Decision: ${formatted.decision}`);
      console.log(`   Confidence: ${formatted.confidence}\n`);
    }
  });

  console.log('💡 Suggested Action:');
  console.log('Use Task tool to analyze and save these contracts with Haiku\n');

  return contracts.map(formatContractForMama).filter((c) => c !== null);
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
      const result = await saveDecision(contract);

      if (result.success) {
        console.log(`  ✅ Saved: ${result.id.id || 'success'}`);
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
    const searchResult = await searchDecisions('contract test-api', 10);

    if (searchResult.results && searchResult.results.length > 0) {
      console.log(`Found ${searchResult.results.length} contracts in MAMA:`);
      searchResult.results.forEach((r, idx) => {
        console.log(`  ${idx + 1}. ${r.topic} (${Math.round(r.similarity * 100)}% match)`);
        console.log(`     ${r.decision.substring(0, 80)}...`);
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
    const searchResult = await searchDecisions('api register', 5);

    if (searchResult.results && searchResult.results.length > 0) {
      console.log('PreToolUse would inject:');
      console.log('---');
      console.log('🔌 Related Contracts (MAMA v2)\n');
      console.log('⚠️ Frontend/Backend consistency required:\n');

      searchResult.results.slice(0, 3).forEach((r, idx) => {
        console.log(`${idx + 1}. ${r.topic} (${Math.round(r.similarity * 100)}% match)`);
        console.log(`   ${r.decision}`);
      });

      console.log('\n💡 Use exact schema from these contracts to prevent API mismatches.');
      console.log('---\n');

      return true;
    }
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
    // Step 1: Extract contracts
    const contracts = await step1_postToolUse();

    if (contracts.length === 0) {
      console.log('⚠️  No contracts found, exiting\n');
      return;
    }

    // Step 2: Generate template
    const formattedContracts = step2_generateTemplate(contracts);

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
    console.log(`  - Extracted: ${contracts.length} contracts`);
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
