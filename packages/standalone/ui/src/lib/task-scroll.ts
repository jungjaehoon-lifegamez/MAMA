interface ScrollTarget {
  scrollIntoView: (options: ScrollIntoViewOptions) => void;
}

export function scrollTaskHashIntoView(
  hash: string,
  scrolledHash: string | null,
  findTarget: (id: string) => ScrollTarget | null
): string | null {
  if (!hash.startsWith('#task-') || scrolledHash === hash) {
    return scrolledHash;
  }

  const target = findTarget(hash.slice(1));
  if (!target) {
    return scrolledHash;
  }

  target.scrollIntoView({ block: 'center' });
  return hash;
}
