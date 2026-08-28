---
name: mama-install
description: Install MAMA OS and follow its self-teaching CLI until the first report is confirmed.
---

# Install MAMA OS

1. Install the local server:

   ```bash
   npm i -g @jungjaehoon/mama-os
   ```

2. Read the current installation contract:

   ```bash
   mama --help
   ```

3. Run the machine-readable observer and follow only the actions it reports:

   ```bash
   mama status --json
   ```

Repeat `mama status --json` after each state change. Ask the human only for actions identified by
the status output as human-required. Do not infer success from installed files or a running daemon;
the installation is complete only when the returned onboarding state says `complete: true`.
