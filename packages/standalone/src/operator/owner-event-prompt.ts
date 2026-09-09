import {
  UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION,
  wrapUntrustedContent,
} from '../utils/untrusted-content.js';
import type { OwnerEventBatch } from './owner-event-inbox.js';
import { buildOwnerEventEffectAuthority } from './owner-event-effects.js';

export interface OwnerEventPromptInput {
  batch: OwnerEventBatch;
  /**
   * The console brief, supplied ONLY on the turn that must carry it: the caller compares
   * its content hash against what this thread was already given (ThreadBriefMemory) and
   * passes null otherwise. Standing policy belongs on the thread once, not in every batch.
   */
  ownerBrief?: string | null;
  skillContent?: string | null;
  ownerTelegramChatId?: string | null;
}

function activationLines(batch: OwnerEventBatch): string[] {
  if (batch.activations.length === 0) return ['- No trigger matched. Judge the delta directly.'];
  return batch.activations.flatMap((activation) =>
    activation.availability === 'unavailable'
      ? [
          '- A matched procedure is unavailable under current access/status. Continue independent work; do not execute its old snapshot.',
        ]
      : [
          `- trigger=${activation.triggerId} kind=${activation.kind}`,
          ...(activation.procedureRef
            ? [
                `  procedure=${activation.procedureRef.id}@${activation.procedureRef.revision}`,
                ...(activation.queuedProcedureRef
                  ? [`  queuedRevision=${activation.queuedProcedureRef.revision}`]
                  : []),
              ]
            : []),
          `  memoryQuery: ${activation.memoryQuery}`,
          `  requiredEvidence: ${activation.requiredEvidence.join(', ') || '(none)'}`,
          ...activation.procedure.map((step) => `  ${step.action}: ${step.description}`),
        ]
  );
}

/**
 * Build one event turn for the same MAMA owner agent used by the owner console.
 *
 * Only batch-specific text belongs here. The fixed completion contract that used to be
 * re-embedded on every batch now lives in OWNER_RUNTIME_RULES (owner-runtime.ts), which
 * the owner runtime's system prompt carries once per thread.
 */
export function buildOwnerEventPrompt(input: OwnerEventPromptInput): string {
  const scope = `owner-event:${input.batch.id}`;
  const effectAuthority = buildOwnerEventEffectAuthority(input.batch);
  const effectKeyLines = [
    `- telegram_send.delivery_key=${effectAuthority.effectKeys.telegram_send}`,
    `- drive_upload.effect_key=${effectAuthority.effectKeys.drive_upload}`,
  ];
  const ownerTarget = input.ownerTelegramChatId
    ? [
        'The host-authorized owner Telegram target for this turn is fixed:',
        `telegram_send({chat_id:${JSON.stringify(
          input.ownerTelegramChatId
        )}, message:"...", delivery_key:${JSON.stringify(
          effectAuthority.effectKeys.telegram_send
        )}})`,
      ]
    : ['No owner Telegram destination is authorized for this turn.'];
  const brief = input.ownerBrief?.trim();
  return [
    '[MAMA OWNER EVENT TURN]',
    ...(brief ? ['', '## Current owner operating brief', brief] : []),
    ...(input.skillContent?.trim()
      ? ['', '## Matched installed skill', input.skillContent.trim()]
      : []),
    '',
    '## Matched trigger activations',
    ...activationLines(input.batch),
    '',
    '## This batch',
    `- If nothing changes, call contract_no_update({scope:${JSON.stringify(scope)}, reason:"..."}).`,
    ...effectKeyLines,
    ...ownerTarget,
    '',
    '## Current connector delta',
    UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION,
    wrapUntrustedContent(`owner-event:${input.batch.channelKey}`, input.batch.lines.join('\n')),
  ].join('\n');
}
