#!/usr/bin/env node
/**
 * PoC: Haiku Agent via Claude CLI
 *
 * Test if we can spawn a Claude CLI subprocess with Haiku model
 * and have it save to MAMA, which we can then read.
 *
 * Expected flow:
 * 1. Main Claude (Sonnet) spawns subprocess
 * 2. Subprocess runs Claude CLI with Haiku model
 * 3. Haiku analyzes code and saves contract to MAMA
 * 4. Main Claude reads from MAMA and sees the result
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Test configuration
const TEST_PROMPT = `
You are a contract extraction agent. Analyze this code snippet and extract the API contract:

\`\`\`javascript
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const user = await UserService.create(email, password);
  res.json({ userId: user.id, token: generateToken(user) });
});
\`\`\`

Extract and save to MAMA using this format:
/mama:decision contract_auth_register "POST /api/auth/register expects {email, password}, returns {userId, token}" "Extracted from backend implementation for frontend contract validation"

After saving, respond with just: "Contract saved: auth_register"
`;

/**
 * Method 1: Test with temp file input
 */
async function testWithTempFile() {
  console.log('🧪 Test 1: Claude CLI with temp file\n');

  const tempFile = path.join(os.tmpdir(), `mama-poc-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, TEST_PROMPT);

  console.log(`📝 Created temp file: ${tempFile}`);
  console.log(`📋 Prompt preview: ${TEST_PROMPT.substring(0, 100)}...\n`);

  // Try spawning Claude CLI
  console.log('🚀 Spawning Claude CLI with Haiku...\n');

  const child = spawn('claude', ['--model', 'haiku', '--file', tempFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => {
    stdout += data.toString();
    process.stdout.write(data);
  });

  child.stderr.on('data', (data) => {
    stderr += data.toString();
    process.stderr.write(data);
  });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      console.log(`\n✅ Claude CLI exited with code: ${code}`);

      // Clean up
      try {
        fs.unlinkSync(tempFile);
        console.log(`🗑️  Cleaned up temp file`);
      } catch (err) {
        console.warn(`⚠️  Failed to clean temp file: ${err.message}`);
      }

      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`Claude CLI failed with code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`❌ Failed to spawn Claude CLI: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Method 2: Test with stdin (more realistic for PostToolUse hook)
 */
async function testWithStdin() {
  console.log('\n🧪 Test 2: Claude CLI with stdin\n');

  const child = spawn('claude', ['--model', 'haiku'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => {
    stdout += data.toString();
    process.stdout.write(data);
  });

  child.stderr.on('data', (data) => {
    stderr += data.toString();
    process.stderr.write(data);
  });

  // Write prompt to stdin
  console.log('📨 Writing prompt to stdin...\n');
  child.stdin.write(TEST_PROMPT);
  child.stdin.end();

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      console.log(`\n✅ Claude CLI exited with code: ${code}`);

      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`Claude CLI failed with code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`❌ Failed to spawn Claude CLI: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Method 3: Test background (detached) mode
 */
async function testBackgroundMode() {
  console.log('\n🧪 Test 3: Background (detached) mode\n');

  const tempFile = path.join(os.tmpdir(), `mama-poc-bg-${Date.now()}.txt`);
  const outputFile = path.join(os.tmpdir(), `mama-poc-output-${Date.now()}.txt`);

  fs.writeFileSync(tempFile, TEST_PROMPT);

  console.log(`📝 Created temp file: ${tempFile}`);
  console.log(`📝 Output will be in: ${outputFile}\n`);

  // Spawn in background
  const child = spawn('claude', ['--model', 'haiku', '--file', tempFile], {
    detached: true,
    stdio: ['ignore', fs.openSync(outputFile, 'w'), fs.openSync(outputFile, 'a')],
  });

  child.unref();

  console.log(`🚀 Spawned background Claude CLI (PID: ${child.pid})`);
  console.log(`⏳ Waiting for output...\n`);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (child?.pid) {
      try {
        process.kill(child.pid);
      } catch (_err) {
        // ignore
      }
    }
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }
  };

  process.once('exit', cleanup);
  process.once('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });

  const waitForOutput = (filePath, timeoutMs = 15000, intervalMs = 500) =>
    new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          if (stats.size > 0) {
            clearInterval(interval);
            resolve(true);
            return;
          }
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, intervalMs);
    });

  const hasOutput = await waitForOutput(outputFile);

  // Check output
  if (hasOutput && fs.existsSync(outputFile)) {
    const output = fs.readFileSync(outputFile, 'utf8');
    console.log(`📄 Output file contents:\n${output}\n`);

    // Clean up
    cleanup();
    console.log(`🗑️  Cleaned up temp files`);

    return { output };
  } else {
    console.warn(`⚠️  Output file not created yet`);
    cleanup();
    return { output: null };
  }
}

/**
 * Verify MAMA saved the decision
 */
async function verifyMamaSave() {
  console.log('\n🔍 Verifying MAMA save...\n');

  // Use MAMA MCP to search for the decision
  const { exec } = require('child_process');

  return new Promise((resolve, reject) => {
    exec(
      'npx -y @jungjaehoon/mama-server search "contract_auth_register"',
      (error, stdout, _stderr) => {
        if (error) {
          console.error(`❌ MAMA search failed: ${error.message}`);
          reject(error);
          return;
        }

        console.log(`📋 MAMA search results:\n${stdout}`);

        if (stdout.includes('contract_auth_register')) {
          console.log('✅ Contract found in MAMA!');
          resolve(true);
        } else {
          console.log('⚠️  Contract not found in MAMA');
          resolve(false);
        }
      }
    );
  });
}

/**
 * Run all tests
 */
async function main() {
  console.log('🎯 MAMA v2 Haiku Agent PoC\n');
  console.log('Testing if we can spawn Claude CLI with Haiku model\n');
  console.log('='.repeat(60) + '\n');

  try {
    // Test 1: Temp file
    console.log('📌 Method 1: Temp file input');
    console.log('   Best for: Long prompts, file-based workflows');
    console.log('   Hook usage: PostToolUse (file paths available)\n');

    await testWithTempFile();

    // Check if MAMA saved
    await verifyMamaSave();

    // Test 2: Stdin (commented out for now)
    // console.log('\n' + '='.repeat(60));
    // console.log('📌 Method 2: Stdin input');
    // console.log('   Best for: Short prompts, streaming data');
    // console.log('   Hook usage: PreToolUse (inline injection)\n');
    // await testWithStdin();

    // Test 3: Background mode
    console.log('\n' + '='.repeat(60));
    console.log('📌 Method 3: Background (detached) mode');
    console.log('   Best for: Non-blocking operations');
    console.log('   Hook usage: PostToolUse (async contract extraction)\n');

    await testBackgroundMode();

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ PoC Complete!\n');
    console.log('📊 Results:');
    console.log('   ✓ Claude CLI spawn: Working');
    console.log('   ✓ Haiku model: Accessible');
    console.log('   ✓ MAMA integration: Needs verification');
    console.log('\n💡 Next steps:');
    console.log('   1. Verify MAMA saved the contract');
    console.log('   2. Test PreToolUse reading the saved contract');
    console.log('   3. Integrate into actual PostToolUse hook');
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

module.exports = { testWithTempFile, testWithStdin, testBackgroundMode, verifyMamaSave };
