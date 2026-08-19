import { describe, expect, it } from 'vitest';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import { projectConsoleBriefForPrompt } from '../../src/operator/console-brief.js';
import { projectWorkOrderBriefForPrompt } from '../../src/operator/briefs.js';

const disabledPrivatePolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: {},
  enabledNames: [],
});

const PRIVATE_CALL_CASES = [
  {
    name: 'plain call',
    line: "- kagemusha_tasks({ status: 'pending' })",
  },
  {
    name: 'bold call',
    line: "- **kagemusha_tasks**({ status: 'pending' })",
  },
  {
    name: 'italic call',
    line: "- *kagemusha_tasks*({ status: 'pending' })",
  },
  {
    name: 'bold-italic call',
    line: "- ***kagemusha_tasks***({ status: 'pending' })",
  },
  {
    name: 'arbitrary matched backtick run',
    line: "- `````kagemusha_tasks`````({ status: 'pending' })",
  },
  {
    name: 'emphasis outside code span',
    line: "- **`kagemusha_tasks`**({ status: 'pending' })",
  },
  {
    name: 'code span outside emphasis',
    line: "- `**kagemusha_tasks**`({ status: 'pending' })",
  },
  {
    name: 'nested underscore, emphasis, and code spans',
    line: "- _**``kagemusha_messages``**_({ channel: 'owner' })",
  },
  {
    name: 'triple-backtick span outside bold-italic emphasis',
    line: "- ```***kagemusha_messages***```({ channel: 'owner' })",
  },
  {
    name: 'strikethrough call',
    line: "- ~~kagemusha_messages~~({ channel: 'owner' })",
  },
] as const;

const NON_CALL_CASES = [
  {
    name: 'plain historical prose',
    line: "- Last year's kagemusha_tasks output used the old status names.",
  },
  {
    name: 'wrapped historical reference without call syntax',
    line: '- Historical **`kagemusha_tasks`** output used the old status names.',
  },
  {
    name: 'mismatched nested emphasis',
    line: "- **`kagemusha_tasks`*({ status: 'pending' })",
  },
  {
    name: 'mismatched backtick runs',
    line: "- ``kagemusha_tasks```({ status: 'pending' })",
  },
  {
    name: 'identifier prefix',
    line: "- archived_kagemusha_tasks({ status: 'pending' })",
  },
  {
    name: 'identifier suffix',
    line: "- kagemusha_tasks_archive({ status: 'pending' })",
  },
] as const;

const PROJECTIONS = [
  {
    name: 'TG-05 console',
    project: (raw: string) => projectConsoleBriefForPrompt(raw, disabledPrivatePolicy),
    appendsManagedBoardContract: false,
  },
  {
    name: 'TG-06 workorder',
    project: (raw: string) => projectWorkOrderBriefForPrompt('board', raw, disabledPrivatePolicy),
    appendsManagedBoardContract: true,
  },
] as const;

describe.each(PROJECTIONS)(
  '$name disabled private prompt projection',
  ({ project, appendsManagedBoardContract }) => {
    it.each(PRIVATE_CALL_CASES)('strips $name', ({ line }) => {
      const raw = `# Brief\n${line}\n- Keep unrelated guidance.\n`;

      const projected = project(raw);

      expect(projected).not.toContain(line);
      expect(projected).toContain('- Keep unrelated guidance.');
    });

    it.each(NON_CALL_CASES)('preserves $name', ({ line }) => {
      const raw = `# Brief\n${line}\n- Keep unrelated guidance.\n`;
      const projected = project(raw);

      if (appendsManagedBoardContract) {
        expect(projected.startsWith(raw)).toBe(true);
        expect(projected).toContain('<!-- MAMA managed board work-order contract v1:start -->');
        expect(projected).toContain('<!-- MAMA managed board work-order contract v1:end -->');
      } else {
        expect(projected).toBe(raw);
      }
    });
  }
);
