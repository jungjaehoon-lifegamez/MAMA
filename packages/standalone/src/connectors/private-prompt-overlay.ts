export const PRIVATE_PROMPT_OVERLAY_START = '<!-- MAMA private connector overlay:start -->';
export const PRIVATE_PROMPT_OVERLAY_END = '<!-- MAMA private connector overlay:end -->';

/** Remove only host-marked private prompt projections; user-owned text stays intact. */
export function stripMarkedPrivatePromptOverlays(raw: string): string {
  let projected = raw;
  let start = projected.indexOf(PRIVATE_PROMPT_OVERLAY_START);
  while (start >= 0) {
    const end = projected.indexOf(
      PRIVATE_PROMPT_OVERLAY_END,
      start + PRIVATE_PROMPT_OVERLAY_START.length
    );
    if (end < 0) {
      return projected;
    }
    projected =
      projected.slice(0, start) + projected.slice(end + PRIVATE_PROMPT_OVERLAY_END.length);
    start = projected.indexOf(PRIVATE_PROMPT_OVERLAY_START);
  }
  return projected;
}

export function wrapPrivatePromptOverlay(content: string): string {
  return `${PRIVATE_PROMPT_OVERLAY_START}\n${content}\n${PRIVATE_PROMPT_OVERLAY_END}`;
}
