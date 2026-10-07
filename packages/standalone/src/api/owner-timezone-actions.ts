import { invalidInput } from '../utils/invalid-input.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';
import type { TimeZoneSetting } from '../runtime/timezone.js';
import { validateTimeZone } from '../runtime/timezone.js';

export interface OwnerTimeZoneActionPorts {
  configPath: string;
  ownerPrincipalId: string;
  setting: TimeZoneSetting;
  isOwnerMessageTurn(sourceMessageRef: string): boolean;
}

function denied(): Error {
  const error = new Error('owner.timezone.set is available only in an owner message turn');
  error.name = 'denied';
  return error;
}

function writeTimeZone(path: string, timeZone: string): void {
  const original = readFileSync(path, 'utf8');
  const line = `timezone: ${JSON.stringify(timeZone)}`;
  const updated = /^timezone:.*$/m.test(original)
    ? original.replace(/^timezone:.*$/m, line)
    : `${original}${original.endsWith('\n') || original.length === 0 ? '' : '\n'}${line}\n`;
  const temporary = join(dirname(path), `.config-${randomUUID()}.tmp`);
  writeFileSync(temporary, updated, { mode: statSync(path).mode & 0o777 });
  renameSync(temporary, path);
}

export function ownerTimeZoneActionRegistrations(
  ports: OwnerTimeZoneActionPorts
): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'owner.timezone.set',
        summary:
          "Set the owner's IANA timezone when the owner states or changes it. Allowed only in a turn that answers an owner message; source-delta, scheduled and replay turns and non-owner callers are denied. It rewrites only the timezone line of config.yaml and applies at once to report hours, displayed times and date-only deadlines. Returns the new and previous timezone; a memory preference does not change it.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['timeZone'],
          properties: {
            timeZone: {
              type: 'string',
              minLength: 1,
              description: 'IANA time zone, e.g. Europe/Paris.',
            },
          },
        },
        examples: [{ title: 'Set owner timezone', input: { timeZone: 'Europe/Paris' } }],
      },
      exec: (input, context: ActionContext) => {
        if (context.access.principalId !== ports.ownerPrincipalId) throw denied();
        if (context.session?.replaySourceEndMs !== undefined) throw denied();
        const sourceMessageRef = context.session?.sourceMessageRef;
        if (!sourceMessageRef || !ports.isOwnerMessageTurn(sourceMessageRef)) throw denied();
        const timeZone = (input as { timeZone?: unknown }).timeZone;
        if (typeof timeZone !== 'string' || timeZone.trim() === '')
          throw invalidInput('timeZone must be a nonblank IANA time zone');
        try {
          validateTimeZone(timeZone);
        } catch {
          throw invalidInput(`timezone "${timeZone}" is not a valid IANA time zone`);
        }
        const previous = ports.setting.get();
        writeTimeZone(ports.configPath, timeZone);
        ports.setting.set(timeZone);
        return { timeZone, previous };
      },
    },
  ];
}
