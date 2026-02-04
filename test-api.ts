/**
 * Test API for MAMA v2 Contract Detection PoC
 */

import express from 'express';
const app = express();

// Middleware: Parse JSON request bodies
app.use(express.json());

// User registration endpoint
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create user
    const user = await createUser(email, password, name);

    // Generate token
    const token = generateToken(user);

    res.json({ userId: user.id, token, email: user.email });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function
async function createUser(email: string, password: string, name?: string) {
  // Implementation here
  return { id: '123', email, name };
}

function generateToken(user: any): string {
  return 'token_' + user.id;
}
