// Register endpoint fixture for contract extraction PoC
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const user = await UserService.create(email, password);
  res.json({ userId: user.id, token: generateToken(user) });
});

// Profile endpoint fixture
app.get('/api/profile', async (req, res) => {
  const profile = await ProfileService.get(req.user.id);
  res.json({ id: profile.id, email: profile.email });
});
