/**
 * Test API for MAMA v2 Contract Detection PoC
 */

import express from 'express';
const app = express();

// User registration endpoint
app.post('/api/auth/register', async (req, res) => {
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
});

// Helper function
async function createUser(email: string, password: string) {
  // Implementation here
  return { id: '123', email };
}

function generateToken(user: any): string {
  return 'token_' + user.id;
}
