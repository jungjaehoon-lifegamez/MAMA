#!/usr/bin/env node
/**
 * Test Contract Extraction
 *
 * Verify that contract-extractor correctly identifies:
 * - API endpoints
 * - Function signatures
 * - Type definitions
 */

const path = require('path');
const CORE_PATH = path.resolve(__dirname, '../../src/core');
const { extractContracts, formatContractForMama } = require(
  path.join(CORE_PATH, 'contract-extractor')
);

// Test code snippets
const testCases = [
  {
    name: 'Express API Endpoint',
    code: `
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const user = await UserService.create(email, password);
  res.json({ userId: user.id, token: generateToken(user) });
});
`,
    expected: {
      apiEndpoints: 1,
      method: 'POST',
      path: '/api/auth/register',
    },
  },
  {
    name: 'Multiple Endpoints',
    code: `
router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  res.json(user);
});

router.delete('/users/:id', async (req, res) => {
  await User.deleteById(req.params.id);
  res.json({ success: true });
});
`,
    expected: {
      apiEndpoints: 2,
    },
  },
  {
    name: 'Function Signatures',
    code: `
function validateEmail(email) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};
`,
    expected: {
      functionSignatures: 2,
    },
  },
  {
    name: 'TypeScript Interfaces',
    code: `
interface User {
  id: string;
  email: string;
  password: string;
  createdAt: Date;
}

type LoginRequest = {
  email: string;
  password: string;
};
`,
    expected: {
      typeDefinitions: 2,
    },
  },
  {
    name: 'Mixed Code (Real World)',
    code: `
// Type definitions
interface RegisterRequest {
  email: string;
  password: string;
}

interface RegisterResponse {
  userId: string;
  token: string;
}

// Service function
async function createUser(email: string, password: string): Promise<User> {
  const hashedPassword = await hashPassword(password);
  return User.create({ email, password: hashedPassword });
}

// API endpoint
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const user = await createUser(email, password);
  res.json({ userId: user.id, token: generateToken(user) });
});
`,
    expected: {
      apiEndpoints: 1,
      functionSignatures: 1,
      typeDefinitions: 2,
    },
  },
];

/**
 * Run tests
 */
function runTests() {
  console.log('🧪 Contract Extraction Tests\n');
  console.log('='.repeat(60) + '\n');

  let passedTests = 0;
  let failedTests = 0;

  testCases.forEach((testCase, idx) => {
    console.log(`Test ${idx + 1}: ${testCase.name}`);

    const result = extractContracts(testCase.code, 'test.ts');

    // Verify counts
    let passed = true;

    if (testCase.expected.apiEndpoints !== undefined) {
      const actual = result.apiEndpoints.length;
      const expected = testCase.expected.apiEndpoints;
      if (actual !== expected) {
        console.log(`  ❌ API endpoints: expected ${expected}, got ${actual}`);
        passed = false;
      } else {
        console.log(`  ✅ API endpoints: ${actual}`);
      }

      // Verify specific endpoint details
      if (testCase.expected.method && result.apiEndpoints.length > 0) {
        const endpoint = result.apiEndpoints[0];
        if (endpoint.method === testCase.expected.method) {
          console.log(`  ✅ Method: ${endpoint.method}`);
        } else {
          console.log(`  ❌ Method: expected ${testCase.expected.method}, got ${endpoint.method}`);
          passed = false;
        }
      }

      if (testCase.expected.path && result.apiEndpoints.length > 0) {
        const endpoint = result.apiEndpoints[0];
        if (endpoint.path === testCase.expected.path) {
          console.log(`  ✅ Path: ${endpoint.path}`);
        } else {
          console.log(`  ❌ Path: expected ${testCase.expected.path}, got ${endpoint.path}`);
          passed = false;
        }
      }
    }

    if (testCase.expected.functionSignatures !== undefined) {
      const actual = result.functionSignatures.length;
      const expected = testCase.expected.functionSignatures;
      if (actual !== expected) {
        console.log(`  ❌ Function signatures: expected ${expected}, got ${actual}`);
        passed = false;
      } else {
        console.log(`  ✅ Function signatures: ${actual}`);
      }
    }

    if (testCase.expected.typeDefinitions !== undefined) {
      const actual = result.typeDefinitions.length;
      const expected = testCase.expected.typeDefinitions;
      if (actual !== expected) {
        console.log(`  ❌ Type definitions: expected ${expected}, got ${actual}`);
        passed = false;
      } else {
        console.log(`  ✅ Type definitions: ${actual}`);
      }
    }

    // Test MAMA formatting
    const allContracts = [
      ...result.apiEndpoints,
      ...result.functionSignatures,
      ...result.typeDefinitions,
    ];

    if (allContracts.length > 0) {
      console.log(`\n  📋 Sample MAMA decision:`);
      const sample = formatContractForMama(allContracts[0]);
      if (sample) {
        console.log(`     Topic: ${sample.topic}`);
        const preview =
          typeof sample.decision === 'string' ? sample.decision.substring(0, 80) : '[no decision]';
        console.log(`     Decision: ${preview}...`);
        console.log(`     Confidence: ${sample.confidence}`);
      }
    }

    if (passed) {
      passedTests++;
      console.log(`  ✅ PASSED\n`);
    } else {
      failedTests++;
      console.log(`  ❌ FAILED\n`);
    }
  });

  console.log('='.repeat(60));
  console.log(`\n📊 Results: ${passedTests} passed, ${failedTests} failed\n`);

  return failedTests === 0;
}

// Run tests
if (require.main === module) {
  const success = runTests();
  process.exit(success ? 0 : 1);
}

module.exports = { runTests };
