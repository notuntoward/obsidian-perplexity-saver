import { describe, expect, it } from "vitest";
import { sortByEngagement, EngagementSortable } from "../src/litNote/engagementSort";

describe("sortByEngagement", () => {
  it("case 1: note created 5 mins ago (never viewed) sorts BEFORE note viewed 2 hours ago created last year", () => {
    const tNow = 1_700_000_000_000;
    const noteCreated5MinAgo: EngagementSortable = {
      path: "noteA.md",
      basename: "noteA",
      stat: { ctime: tNow - 5 * 60 * 1000, mtime: tNow - 5 * 60 * 1000 },
    };
    const noteViewed2HoursAgo: EngagementSortable = {
      path: "noteB.md",
      basename: "noteB",
      stat: { ctime: tNow - 365 * 24 * 3600 * 1000, mtime: tNow - 365 * 24 * 3600 * 1000 },
    };

    const lastViewed = new Map<string, number>([
      ["noteB.md", tNow - 2 * 3600 * 1000],
    ]);

    const sorted = sortByEngagement([noteViewed2HoursAgo, noteCreated5MinAgo], lastViewed);
    expect(sorted[0].path).toBe("noteA.md");
    expect(sorted[1].path).toBe("noteB.md");
  });

  it("case 2: note viewed 5 mins ago (created last year) sorts BEFORE note created yesterday and never viewed", () => {
    const tNow = 1_700_000_000_000;
    const noteViewed5MinAgo: EngagementSortable = {
      path: "noteA.md",
      basename: "noteA",
      stat: { ctime: tNow - 365 * 24 * 3600 * 1000, mtime: tNow - 365 * 24 * 3600 * 1000 },
    };
    const noteCreatedYesterday: EngagementSortable = {
      path: "noteB.md",
      basename: "noteB",
      stat: { ctime: tNow - 24 * 3600 * 1000, mtime: tNow - 24 * 3600 * 1000 },
    };

    const lastViewed = new Map<string, number>([
      ["noteA.md", tNow - 5 * 60 * 1000],
    ]);

    const sorted = sortByEngagement([noteCreatedYesterday, noteViewed5MinAgo], lastViewed);
    expect(sorted[0].path).toBe("noteA.md");
    expect(sorted[1].path).toBe("noteB.md");
  });

  it("case 3: note with old ctime and very recent mtime (never viewed) sorts AFTER both notes in cases 1 and 2", () => {
    const tNow = 1_700_000_000_000;
    const noteCase1: EngagementSortable = {
      path: "case1.md",
      basename: "case1",
      stat: { ctime: tNow - 5 * 60 * 1000, mtime: tNow - 5 * 60 * 1000 },
    };
    const noteCase2: EngagementSortable = {
      path: "case2.md",
      basename: "case2",
      stat: { ctime: tNow - 365 * 24 * 3600 * 1000, mtime: tNow - 365 * 24 * 3600 * 1000 },
    };
    const noteOldCtimeRecentMtime: EngagementSortable = {
      path: "oldCtime.md",
      basename: "oldCtime",
      stat: { ctime: tNow - 30 * 24 * 3600 * 1000, mtime: tNow - 1000 },
    };

    const lastViewed = new Map<string, number>([
      ["case2.md", tNow - 5 * 60 * 1000],
    ]);

    const sorted = sortByEngagement([noteOldCtimeRecentMtime, noteCase1, noteCase2], lastViewed);
    expect(sorted[0].path).toMatch(/case1|case2/);
    expect(sorted[1].path).toMatch(/case1|case2/);
    expect(sorted[2].path).toBe("oldCtime.md");
  });

  it("case 4: equal engagement time: newer mtime sorts first", () => {
    const tNow = 1_700_000_000_000;
    const fileA: EngagementSortable = {
      path: "a.md",
      basename: "a",
      stat: { ctime: tNow - 1000, mtime: tNow - 500 },
    };
    const fileB: EngagementSortable = {
      path: "b.md",
      basename: "b",
      stat: { ctime: tNow - 1000, mtime: tNow - 100 },
    };

    const sorted = sortByEngagement([fileA, fileB], new Map());
    expect(sorted[0].path).toBe("b.md");
    expect(sorted[1].path).toBe("a.md");
  });

  it("case 5: equal engagement and equal mtime: alphabetical by basename", () => {
    const tNow = 1_700_000_000_000;
    const fileZ: EngagementSortable = {
      path: "z.md",
      basename: "z",
      stat: { ctime: tNow, mtime: tNow },
    };
    const fileA: EngagementSortable = {
      path: "a.md",
      basename: "a",
      stat: { ctime: tNow, mtime: tNow },
    };

    const sorted = sortByEngagement([fileZ, fileA], new Map());
    expect(sorted[0].path).toBe("a.md");
    expect(sorted[1].path).toBe("z.md");
  });

  it("case 6: file with no stat does not throw and sorts last", () => {
    const tNow = 1_700_000_000_000;
    const fileWithStat: EngagementSortable = {
      path: "withStat.md",
      basename: "withStat",
      stat: { ctime: tNow, mtime: tNow },
    };
    const fileNoStat: EngagementSortable = {
      path: "noStat.md",
      basename: "noStat",
    };

    const sorted = sortByEngagement([fileNoStat, fileWithStat], new Map());
    expect(sorted[0].path).toBe("withStat.md");
    expect(sorted[1].path).toBe("noStat.md");
  });

  it("case 7: input array is not modified", () => {
    const fileA: EngagementSortable = { path: "a.md", basename: "a" };
    const fileB: EngagementSortable = { path: "b.md", basename: "b" };
    const input = [fileA, fileB];
    const inputCopy = [...input];

    sortByEngagement(input, new Map());
    expect(input).toEqual(inputCopy);
  });
});
