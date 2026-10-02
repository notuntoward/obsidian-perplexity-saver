export const MAX_TRACKED_VIEWS = 2000;

export class ViewTracker {
  private views = new Map<string, number>();

  constructor(initial?: Record<string, number>) {
    if (initial) {
      for (const [path, ts] of Object.entries(initial)) {
        if (typeof ts === "number" && Number.isFinite(ts)) {
          this.views.set(path, ts);
        }
      }
    }
  }

  get map(): ReadonlyMap<string, number> {
    return this.views;
  }

  get size(): number {
    return this.views.size;
  }

  record(path: string, now: number): void {
    this.views.set(path, now);
    this.prune();
  }

  rename(oldPath: string, newPath: string): void {
    const ts = this.views.get(oldPath);
    if (ts === undefined) return;
    this.views.delete(oldPath);
    this.views.set(newPath, ts);
  }

  remove(path: string): void {
    this.views.delete(path);
  }

  // Only used on first run, when nothing has been recorded yet.
  // recentPaths[0] is the most recently opened file.
  seedIfEmpty(recentPaths: readonly string[], now: number): void {
    if (this.views.size > 0) return;
    recentPaths.forEach((path, index) => {
      this.views.set(path, now - index * 60_000);
    });
  }

  toRecord(): Record<string, number> {
    return Object.fromEntries(this.views);
  }

  private prune(): void {
    if (this.views.size <= MAX_TRACKED_VIEWS) return;
    const oldestFirst = [...this.views.entries()].sort((a, b) => a[1] - b[1]);
    const excess = this.views.size - MAX_TRACKED_VIEWS;
    for (let i = 0; i < excess; i++) this.views.delete(oldestFirst[i][0]);
  }
}
