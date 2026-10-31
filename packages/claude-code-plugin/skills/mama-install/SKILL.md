---
name: mama-install
description: Install MAMA OS and guide the owner through setup until MAMA answers their first message.
---

# Install MAMA OS

You install MAMA OS through this conversation; the person decides every choice and never types in
a terminal. The procedure is "Set up through your agent" in the
[owner setup guide](https://github.com/jungjaehoon-lifegamez/MAMA/blob/main/docs/start/owner-setup.md);
follow it.

The person enters secrets and the pairing code only in the setup page MAMA opens in their browser,
never in this chat: the conversation reaches the model provider and this agent's transcript. Never
read `open.html` and never POST to the setup page. The page is the person's.

1. Ask which backend MAMA runs (you, unless the person picks the other) and which model.

2. Run the install command in the background, with its output in a file:

   ```bash
   curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | MAMA_INIT_MODEL=<model> sh -s -- --backend <claude|codex> --non-interactive
   ```

   Read the file as it grows. When it says the setup page opened, tell the person it is open in
   their browser. If the browser did not open, give them the `file://` path of `open.html` that
   the output names, to paste into the address bar; the path holds no secret.

3. Pass on the sign-in lines and the page's steps. A backend that is not signed in stops the
   command, which names the login with the backend's full path: run it in the background and give
   the person its URL and code. Codex's device page warns to cancel a code "another person gave
   you"; say that this code comes from the login you started on their machine.

4. After a sign-in, run the same install command again. Use full paths: your shell does not read
   the PATH block the installer writes, so run `~/.mama/bin/mama` and the backend by their paths.

5. Setup is done when MAMA answers the person's message to their bot. Files on disk or a running
   service are not the end.

Sources (Gmail, Calendar, Slack and the others) and Jev are not set up from the conversation
yet: today each needs the person at a terminal, which this install does not use. Do not offer
them during the install. If the person asks for one, say that MAMA cannot set it up through you
yet, and that it works without them.

If the person asks about Jev (TypeSafe): with it, the owner agent can judge many messages or items
without reading them all, and the text in those calls goes to the Jev service. MAMA works the same
without it.
