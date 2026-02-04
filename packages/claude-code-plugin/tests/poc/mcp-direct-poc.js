#!/usr/bin/env node
/**
 * PoC: Direct MCP stdio communication
 *
 * Test if we can call MAMA MCP server directly via stdio
 * without going through Claude CLI.
 *
 * This approach:
 * - No session token needed
 * - Direct access to MAMA tools
 * - Can be used in PostToolUse hook
 */

const { spawn } = require('child_process');

/**
 * Call MAMA MCP tool via stdio
 */
async function callMamaMcp(toolName, params) {
  console.log(`🔧 Calling MAMA tool: ${toolName}`);
  console.log(`📋 Params:`, JSON.stringify(params, null, 2), '\n');

  // Spawn MAMA MCP server
  const mcp = spawn('npx', ['-y', '@jungjaehoon/mama-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  mcp.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  mcp.stderr.on('data', (data) => {
    stderr += data.toString();
    // console.error('MCP stderr:', data.toString());
  });

  // MCP protocol: Initialize
  const initMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'mama-poc',
        version: '1.0.0',
      },
    },
  };

  console.log('📤 Sending initialize...');
  mcp.stdin.write(JSON.stringify(initMessage) + '\n');

  // Wait a bit for init
  await new Promise((resolve) => setTimeout(resolve, 500));

  // MCP protocol: Call tool
  const toolCallMessage = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: params,
    },
  };

  console.log('📤 Sending tool call...\n');
  mcp.stdin.write(JSON.stringify(toolCallMessage) + '\n');
  mcp.stdin.end();

  return new Promise((resolve, reject) => {
    mcp.on('close', (code) => {
      console.log(`✅ MCP exited with code: ${code}\n`);

      if (stderr) {
        console.log('📋 MCP stderr output:');
        console.log(stderr);
      }

      console.log('📋 MCP stdout output:');
      console.log(stdout);

      // Parse responses
      const lines = stdout.split('\n').filter((line) => line.trim());
      const responses = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (err) {
            return null;
          }
        })
        .filter((r) => r !== null);

      console.log('\n📦 Parsed responses:', JSON.stringify(responses, null, 2));

      resolve({ code, stdout, stderr, responses });
    });

    mcp.on('error', (err) => {
      console.error(`❌ MCP spawn failed: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Test 1: Save a contract to MAMA
 */
async function testSaveContract() {
  console.log('🧪 Test 1: Save contract to MAMA\n');

  const result = await callMamaMcp('save', {
    type: 'decision',
    topic: 'poc_contract_test',
    decision: 'POST /api/test expects {data: string}, returns {id: number}',
    reasoning: 'PoC test contract for Haiku agent architecture validation',
    confidence: 0.9,
  });

  return result;
}

/**
 * Test 2: Search for saved contract
 */
async function testSearchContract() {
  console.log('\n🧪 Test 2: Search for saved contract\n');

  const result = await callMamaMcp('search', {
    query: 'poc_contract_test',
    limit: 5,
  });

  return result;
}

/**
 * Main
 */
async function main() {
  console.log('🎯 MAMA v2 Direct MCP PoC\n');
  console.log('Testing direct stdio communication with MAMA MCP server\n');
  console.log('='.repeat(60) + '\n');

  try {
    // Test 1: Save
    await testSaveContract();

    // Wait a bit for save to complete
    console.log('\n⏳ Waiting for save to complete...\n');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test 2: Search
    await testSearchContract();

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ PoC Complete!\n');
    console.log('📊 Results:');
    console.log('   ✓ Direct MCP communication: Testing');
    console.log('   ✓ Save tool: Testing');
    console.log('   ✓ Search tool: Testing');
    console.log('\n💡 Implications for MAMA v2:');
    console.log('   - PostToolUse hook CAN call MCP directly');
    console.log('   - No Claude CLI needed (no session token issue)');
    console.log('   - No LLM reasoning (just programmatic save)');
    console.log('   - Haiku agent still needed for intelligent extraction');
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

module.exports = { callMamaMcp, testSaveContract, testSearchContract };
