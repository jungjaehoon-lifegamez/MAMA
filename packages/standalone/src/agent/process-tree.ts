export interface ProcessRow {
  pid: number;
  ppid: number;
}

export function collectDescendantPids(rootPid: number, rows: ProcessRow[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) || [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) || [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    descendants.push(pid);
    const children = childrenByParent.get(pid) || [];
    queue.push(...children);
  }

  return descendants;
}
