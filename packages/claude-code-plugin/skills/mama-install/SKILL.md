---
name: mama-install
description: Install MAMA OS and guide the owner through setup until MAMA answers their first message.
---

# Install MAMA OS

You install; the owner decides every choice and types every secret.

1. Install the local server and read its commands:

   ```bash
   npm i -g @jungjaehoon/mama-os
   mama --help
   ```

2. Setup is `mama init`. It asks for tokens at hidden prompts, so the owner runs it in their own
   terminal. Never ask for a token, key or password in the conversation. Before they start, walk
   them through what it asks, following the
   [owner setup guide](https://github.com/jungjaehoon-lifegamez/MAMA/blob/main/docs/start/owner-setup.md);
   its `node packages/standalone/dist/cli/index.js` form is for a source checkout, and after
   `npm i -g` the command is `mama`.

3. One choice sends owner text out: `mama init` asks whether to use Jev (TypeSafe). With it, the
   owner agent can judge many messages or items without reading them all; the text in those calls
   goes to the Jev service. Explain this and let the owner choose. MAMA works the same without it.
   If they choose it, they get a key from TypeSafe (https://docs.typesafe.ai) and type it at the
   hidden prompt; it is stored in `~/.mama/jev-key` (0600).

4. Have the owner sign in the backend as `mama init` prints, then start MAMA with the command it
   prints. `mama status` shows whether it is running.

Installation is complete only when the owner sends a message to their bot and MAMA answers. Files
on disk or a running daemon are not the end.
