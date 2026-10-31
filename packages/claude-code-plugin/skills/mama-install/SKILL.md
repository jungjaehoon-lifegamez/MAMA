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

6. Then offer sources. They are not part of the install itself: do not offer them before MAMA
   answers. Once it has answered, ask the person which sources MAMA should watch. Name each source
   in the table of the
   [connectors guide](https://github.com/jungjaehoon-lifegamez/MAMA/blob/main/docs/guides/connectors.md),
   with its line of what it collects; read the list there, not from memory. Leave out the
   Kagemusha bridge, which a new install cannot use. Set up each source the person picks, one at
   a time, as below. If they decline or say later, skip this, and tell them they can ask for a
   source at any time.

To set up a source from the conversation, now or whenever the person asks:

- Agree with the person on what the source reads, and write its block in `connectors.json`'s
  shape, as the connectors guide shows it. A block names its secrets by `auth.tokenName` and never
  holds one. A block replaces that source's whole entry: for a source that is already on, start
  from its block in `~/.mama/connectors.json` and add to it, so its channels stay.
- Enable it with MAMA stopped, the blocks as one JSON object in `MAMA_INIT_CONNECTORS`, in the
  background with its output in a file, as the install command runs:

  ```bash
  ~/.mama/bin/mama stop
  MAMA_INIT_CONNECTORS='{"gmail": {...}}' ~/.mama/bin/mama init --section connectors --non-interactive
  ```

  A source with a token opens the setup page for it, one field each; tell the person it is open,
  as in step 2. The command saves nothing until every check passes, and it leaves MAMA stopped
  however it ends. Start MAMA again with `~/.mama/bin/mama service start` as soon as each run
  ends, before you wait on the person for the next step; stop it again only for the next run.

- Gmail, Calendar, Drive and Sheets run Google's `gws`, which signs in through an OAuth client of
  the person's own. In this order:
  1. The client. In Google Cloud Console the person creates a project and enables the APIs its
     sources use: `gmail.googleapis.com`, `calendar-json.googleapis.com`,
     `drive.googleapis.com` and `sheets.googleapis.com`. They set up the OAuth consent screen by
     account:
     - A gmail.com account: user type External. They fill in the app name and support email,
       add themselves as a test user while setting up, then press "Publish app" so the app is In
       production. Google may also ask for a homepage and a privacy policy URL. The first sign-in shows "Google hasn't verified this app":
       they choose Advanced, then continue. After that the sign-in does not end after 7 days.
     - A Google Workspace account: user type Internal, in their organization's Cloud project.
       There is no warning, no test user and no 7-day end.

     Then they create an OAuth client of type Desktop app and download its JSON. Move that file to
     `~/.config/gws/client_secret.json` with mode 0600, without printing it: it is the tool's own
     credential, not a MAMA secret. If the client is left in Testing, Google ends the sign-in after
     7 days.

  2. The tool. Run the enabling command above. While neither MAMA's service nor your shell finds
     `gws`, it saves nothing and prints the command that installs it; run that command. When your
     shell finds `gws` but the service does not, it saves nothing and prints that MAMA's service
     install adds its folder to the service's PATH; run `~/.mama/bin/mama service install`.
  3. The login. While `gws` cannot read for the new source (no sign-in, or one made for other
     services), the enabling command saves nothing and prints the login
     (`gws auth login --scopes <scopes>`), naming the scope of every Google source that is on:
     read-only for Gmail, Calendar and Sheets, and full Drive access, which large-file delivery to
     Drive needs. Run it exactly as printed, in the background, and give the person the address it prints. Never open or
     complete the Google consent yourself: the person does it in their browser. Your sandbox may
     block the local address gws waits on for the browser's answer; if the login fails that way,
     say so to the person.
  4. Enabling. Run the enabling command again; once `gws` is installed and signed in, it saves
     the source. Then start MAMA.

Jev is not set up from the conversation yet: it needs the person at a terminal, which this
install does not use. Do not offer it. If the person asks for it, say that MAMA cannot turn it on
through you yet, and that MAMA works without it.

If the person asks about Jev (TypeSafe): with it, the owner agent can judge many messages or items
without reading them all, and the text in those calls goes to the Jev service. MAMA works the same
without it.
