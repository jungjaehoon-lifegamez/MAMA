/** Compatibility entry point: setup now renders the authoritative status contract. */

import { statusCommand } from './status.js';

export async function setupCommand(): Promise<void> {
  await statusCommand({ json: false });
}
