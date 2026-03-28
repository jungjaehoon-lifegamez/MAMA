interface RecallBundleLike {
  profile?: {
    static?: Array<{ summary?: string }>;
    dynamic?: Array<{ summary?: string }>;
  };
  memories?: Array<{ topic?: string; summary?: string }>;
}

function sanitizePromptValue(value: string | undefined): string {
  const normalized = value ?? '<no summary>';
  return normalized
    .replace(/\[\/?MAMA/gi, '［MAMA')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/</g, '〈')
    .replace(/>/g, '〉');
}

export function formatRecallBundle(bundle: RecallBundleLike): string {
  const lines: string[] = [];

  if (bundle.profile?.static?.length || bundle.profile?.dynamic?.length) {
    lines.push('[MAMA Profile]');
    if (bundle.profile?.static?.length) {
      lines.push(
        `Static: ${bundle.profile.static.map((item) => sanitizePromptValue(item.summary)).join('; ')}`
      );
    }
    if (bundle.profile?.dynamic?.length) {
      lines.push(
        `Dynamic: ${bundle.profile.dynamic
          .map((item) => sanitizePromptValue(item.summary))
          .join('; ')}`
      );
    }
    lines.push('[/MAMA Profile]');
  }

  if (bundle.memories?.length) {
    lines.push('[MAMA Memories]');
    for (const memory of bundle.memories) {
      lines.push(
        `- ${sanitizePromptValue(memory.topic ?? '<unknown topic>')}: ${sanitizePromptValue(memory.summary)}`
      );
    }
    lines.push('[/MAMA Memories]');
  }

  return lines.join('\n');
}

export function formatAuditNotice(notice: {
  severity: string;
  summary: string;
  recommended_action: string;
  relevant_memories?: Array<{ topic?: string; summary?: string }>;
}): string {
  const lines = [
    '[MAMA Notice]',
    `Severity: ${sanitizePromptValue(notice.severity)}`,
    `Summary: ${sanitizePromptValue(notice.summary)}`,
    `Action: ${sanitizePromptValue(notice.recommended_action)}`,
  ];

  if (notice.relevant_memories?.length) {
    lines.push('Relevant memories:');
    for (const memory of notice.relevant_memories) {
      lines.push(
        `- ${sanitizePromptValue(memory.topic ?? '<unknown topic>')}: ${sanitizePromptValue(memory.summary)}`
      );
    }
  }

  lines.push('[/MAMA Notice]');
  return lines.join('\n');
}
