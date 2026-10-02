import { describe, expect, it } from "vitest";
import { ViewTracker, MAX_TRACKED_VIEWS } from "../src/litNote/viewTracker";

describe("ViewTracker", () => {
  it("case 1: record() then map.get() returns the timestamp", () => {
    const tracker = new ViewTracker();
    const tNow = 1_700_000_000_000;
    tracker.record("noteA.md", tNow);
    expect(tracker.map.get("noteA.md")).toBe(tNow);
  });

  it("case 2: rename() moves the timestamp to the new path and removes the old one", () => {
    const tracker = new ViewTracker();
    const tNow = 1_700_000_000_000;
    tracker.record("oldPath.md", tNow);
    tracker.rename("oldPath.md", "newPath.md");

    expect(tracker.map.get("oldPath.md")).toBeUndefined();
    expect(tracker.map.get("newPath.md")).toBe(tNow);
  });

  it("case 3: rename() of an unknown path does nothing", () => {
    const tracker = new ViewTracker();
    tracker.record("existing.md", 100);
    tracker.rename("unknown.md", "newPath.md");

    expect(tracker.size).toBe(1);
    expect(tracker.map.get("existing.md")).toBe(100);
    expect(tracker.map.get("newPath.md")).toBeUndefined();
  });

  it("case 4: remove() deletes the entry", () => {
    const tracker = new ViewTracker();
    tracker.record("noteA.md", 100);
    tracker.remove("noteA.md");

    expect(tracker.map.get("noteA.md")).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it("case 5: seedIfEmpty() sets index 0 to now, index 1 to now - 60000", () => {
    const tracker = new ViewTracker();
    const now = 1_700_000_000_000;
    tracker.seedIfEmpty(["first.md", "second.md", "third.md"], now);

    expect(tracker.map.get("first.md")).toBe(now);
    expect(tracker.map.get("second.md")).toBe(now - 60_000);
    expect(tracker.map.get("third.md")).toBe(now - 120_000);
  });

  it("case 6: seedIfEmpty() does nothing when the tracker already has entries", () => {
    const tracker = new ViewTracker({ "existing.md": 12345 });
    const now = 1_700_000_000_000;
    tracker.seedIfEmpty(["first.md"], now);

    expect(tracker.size).toBe(1);
    expect(tracker.map.get("existing.md")).toBe(12345);
    expect(tracker.map.get("first.md")).toBeUndefined();
  });

  it("case 7: recording MAX_TRACKED_VIEWS + 10 distinct paths leaves exactly MAX_TRACKED_VIEWS entries, and 10 oldest are gone", () => {
    const tracker = new ViewTracker();
    const totalToRecord = MAX_TRACKED_VIEWS + 10;

    for (let i = 0; i < totalToRecord; i++) {
      tracker.record(`path_${i}.md`, 1000 + i);
    }

    expect(tracker.size).toBe(MAX_TRACKED_VIEWS);

    // Oldest 10 (0..9) should be gone
    for (let i = 0; i < 10; i++) {
      expect(tracker.map.get(`path_${i}.md`)).toBeUndefined();
    }

    // Remaining (10..MAX_TRACKED_VIEWS+9) should exist
    for (let i = 10; i < totalToRecord; i++) {
      expect(tracker.map.get(`path_${i}.md`)).toBe(1000 + i);
    }
  });

  it("case 8: toRecord() round-trips: new ViewTracker(t.toRecord()).map equals t.map", () => {
    const tracker1 = new ViewTracker();
    tracker1.record("a.md", 100);
    tracker1.record("b.md", 200);

    const rec = tracker1.toRecord();
    const tracker2 = new ViewTracker(rec);

    expect(new Map(tracker2.map)).toEqual(new Map(tracker1.map));
  });

  it("case 9: constructor ignores non-numeric values", () => {
    const initial: any = {
      "valid.md": 1000,
      "invalidString.md": "not a number",
      "invalidNaN.md": NaN,
      "invalidNull.md": null,
      "invalidUndefined.md": undefined,
    };

    const tracker = new ViewTracker(initial);
    expect(tracker.size).toBe(1);
    expect(tracker.map.get("valid.md")).toBe(1000);
  });
});
