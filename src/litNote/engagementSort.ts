export interface EngagementSortable {
  path: string;
  basename: string;
  stat?: { mtime?: number; ctime?: number };
}

export function sortByEngagement<T extends EngagementSortable>(
  files: readonly T[],
  lastViewed: ReadonlyMap<string, number>
): T[] {
  const engaged = (f: T): number =>
    Math.max(lastViewed.get(f.path) ?? 0, f.stat?.ctime ?? 0);
  return [...files].sort((a, b) => {
    const byEngaged = engaged(b) - engaged(a);
    if (byEngaged !== 0) return byEngaged;
    const byModified = (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0);
    if (byModified !== 0) return byModified;
    return a.basename.localeCompare(b.basename);
  });
}
