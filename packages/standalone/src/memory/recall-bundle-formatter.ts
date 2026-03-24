interface RecallBundleLike {
  profile?: {
    static?: Array<{ summary?: string }>;
    dynamic?: Array<{ summary?: string }>;
  };
  memories?: Array<{ topic?: string; summary?: string }>;
}

export function formatRecallBundle(bundle: RecallBundleLike): string {
  const lines: string[] = [];

  if (bundle.profile?.static?.length || bundle.profile?.dynamic?.length) {
    lines.push('[MAMA Profile]');
    if (bundle.profile?.static?.length) {
      lines.push(`Static: ${bundle.profile.static.map((item) => item.summary).join('; ')}`);
    }
    if (bundle.profile?.dynamic?.length) {
      lines.push(`Dynamic: ${bundle.profile.dynamic.map((item) => item.summary).join('; ')}`);
    }
    lines.push('[/MAMA Profile]');
  }

  if (bundle.memories?.length) {
    lines.push('[MAMA Memories]');
    for (const memory of bundle.memories) {
      lines.push(`- ${memory.topic}: ${memory.summary}`);
    }
    lines.push('[/MAMA Memories]');
  }

  return lines.join('\n');
}
