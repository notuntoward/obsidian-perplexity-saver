import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { changesProperties, defaultProperties, executeMerge, insertMergedText, planMerge, redirectedLink, suggestKeeper, userBlocks } from "../../src/litNote/noteMerge";

const TEMPLATE = `---
title: Paper
zotero_item_key: ABC
---
> [!info] Paper
> - **Authors:** Someone

> Someone (2022). Paper. Journal.

==Delete this and write here.==

___
> [!note]- &nbsp; Zotero Note
> Highlights
`;

function file(path: string): TFile {
	const name = path.split("/").pop()!;
	return Object.assign(new TFile(), { path, name, basename: name.replace(/\.md$/, ""), extension: "md" });
}

interface Link { link: string; original: string; start: number }

/** A small vault: note text, frontmatter and links, re-indexed from the text whenever a note changes. */
function vault(notes: Record<string, { text: string; fm?: Record<string, unknown> }>) {
	const files = new Map(Object.keys(notes).map((path) => [path, file(path)]));
	const byName = (link: string) => [...files.values()].find((entry) => entry.basename === link.split("#")[0] || entry.path === link.split("#")[0]);
	const links = (path: string): Link[] => [...notes[path].text.matchAll(/\[\[([^\]|#]*)(#[^\]|]*)?(\|[^\]]*)?\]\]/g)]
		.map((match) => ({ link: match[1] + (match[2] ?? ""), original: match[0], start: match.index! }));
	const trashed: string[] = [];
	const app = {
		vault: {
			read: vi.fn(async (entry: TFile) => notes[entry.path].text),
			cachedRead: vi.fn(async (entry: TFile) => notes[entry.path].text),
			process: vi.fn(async (entry: TFile, update: (text: string) => string) => {
				notes[entry.path].text = update(notes[entry.path].text);
				return notes[entry.path].text;
			}),
			getAbstractFileByPath: (path: string) => (notes[path] ? files.get(path) : null),
			getMarkdownFiles: () => [...files.values()].filter((entry) => notes[entry.path]),
		},
		fileManager: {
			processFrontMatter: vi.fn(async (entry: TFile, update: (fm: Record<string, unknown>) => void) => {
				notes[entry.path].fm ??= {};
				update(notes[entry.path].fm!);
			}),
			trashFile: vi.fn(async (entry: TFile) => {
				trashed.push(entry.path);
				delete notes[entry.path];
			}),
		},
		metadataCache: {
			getFileCache: (entry: TFile) => notes[entry.path] && {
				frontmatter: notes[entry.path].fm,
				links: links(entry.path).map((ref) => ({ ...ref, position: { start: { offset: ref.start }, end: { offset: ref.start + ref.original.length } } })),
			},
			getFirstLinkpathDest: (link: string) => byName(link) ?? null,
			fileToLinktext: (entry: TFile) => entry.basename,
			get resolvedLinks() {
				return Object.fromEntries(Object.keys(notes).map((path) => [path,
					Object.fromEntries(links(path).map((ref) => [byName(ref.link)?.path ?? ref.link, 1]))]));
			},
		},
	};
	return { app: app as unknown as App, notes, files, trashed };
}

const all = (plan: Awaited<ReturnType<typeof planMerge>>, trash: string[] = []) => ({
	blocks: new Map(plan.sources.map((source) => [source.file.path, new Set(source.blocks.map((_, index) => index))])),
	trashZoteroItems: new Set(trash),
	properties: defaultProperties(plan.properties),
});

describe("note merge", () => {
	it("finds only the user's own text, leaving out generated sections and placeholders", () => {
		expect(userBlocks(TEMPLATE)).toEqual([]);
		const blocks = userBlocks(TEMPLATE.replace("==Delete this and write here.==", "My idea.\n- point one\n  continued\n- point two\n\n```\ncode\n\nmore\n```"));
		expect(blocks.map((block) => block.text)).toEqual(["My idea.", "- point one\n  continued", "- point two", "```\ncode\n\nmore\n```"]);
	});

	it("puts merged text in place of the placeholder, else before the Zotero Note, else at the end", () => {
		const placeholder = insertMergedText(TEMPLATE, "MERGED");
		expect(placeholder.content).not.toContain("Delete this and write here");
		expect(placeholder.content.split("\n")[placeholder.line]).toBe("MERGED");
		const noted = insertMergedText(TEMPLATE.replace("==Delete this and write here.==", "Mine."), "MERGED");
		expect(noted.content).toMatch(/Mine\.\n\nMERGED\n\n___\n> \[!note\]/);
		expect(insertMergedText("Just text.\n", "MERGED").content).toBe("Just text.\n\nMERGED\n");
	});

	it("keeps display text, headings and link style when redirecting a link", () => {
		const { app } = vault({});
		const to = file("lit/Keeper.md");
		expect(redirectedLink(app, "[[Old#Methods|the methods]]", "Old#Methods", to, "a.md")).toBe("[[Keeper#Methods|the methods]]");
		expect(redirectedLink(app, "![[Old]]", "Old", to, "a.md")).toBe("![[Keeper]]");
		expect(redirectedLink(app, "[see](lit/Old%20one.md#x)", "lit/Old%20one.md#x", to, "a.md")).toBe("[see](lit/Keeper.md#x)");
		expect(redirectedLink(app, "[see](<Old one>)", "Old one", to, "a.md")).toBe("[see](<Keeper>)");
	});

	it("suggests the note with the most user text", async () => {
		const { app, files } = vault({
			"lit/Empty.md": { text: TEMPLATE },
			"lit/Written.md": { text: TEMPLATE.replace("==Delete this and write here.==", "My notes.") },
			"a.md": { text: "[[Empty]] [[Empty]]" },
		});
		expect((await suggestKeeper(app, [files.get("lit/Empty.md")!, files.get("lit/Written.md")!])).path).toBe("lit/Written.md");
	});

	it("copies the chosen text, redirects links and moves the merged note to trash", async () => {
		const { app, notes, files, trashed } = vault({
			"lit/Keeper.md": { text: TEMPLATE.replace("==Delete this and write here.==", "Kept idea.\n\nSee [[Old]]."), fm: { title: "Paper", aliases: ["P"], tags: ["a"] } },
			"lit/Old.md": { text: TEMPLATE.replace("==Delete this and write here.==", "Kept idea.\n\nNew idea [[Other]]."), fm: { title: "Old paper", tags: ["b"] } },
			"Other.md": { text: "Read [[Old#Methods|methods]] and ![[Old]]." },
		});
		const keeper = files.get("lit/Keeper.md")!;
		const plan = await planMerge(app, keeper, [files.get("lit/Old.md")!]);
		expect(plan.sources[0].blocks.map((block) => block.text)).toEqual(["New idea [[Other]]."]);
		expect(plan.sources[0].linkedFrom).toEqual(["Other.md"]);

		const result = await executeMerge(app, plan, all(plan), new Date("2025-01-02T00:00:00Z"));

		expect(result).toMatchObject({ merged: [files.get("lit/Old.md")], kept: [], copiedBlocks: 1, redirectedLinks: 3 });
		expect(trashed).toEqual(["lit/Old.md"]);
		expect(notes["Other.md"].text).toBe("Read [[Keeper#Methods|methods]] and ![[Keeper]].");
		const kept = notes["lit/Keeper.md"].text;
		expect(kept).toContain("See [[Keeper]].");
		expect(kept).toContain("**Merged from Old on 2025-01-02. Tidy this text, then remove this line.**\n\nNew idea [[Other]].");
		expect(kept.split("\n")[result.markerLine!]).toContain("Merged from Old");
		expect(notes["lit/Keeper.md"].fm).toMatchObject({ aliases: ["P", "Old paper"], tags: ["a", "b"] });

		const again = await executeMerge(app, { ...plan, sources: [] }, all(plan));
		expect(again.copiedBlocks).toBe(0);
	});

	it("merges properties: adds missing ones, unions lists, lets the user settle differing values and leaves Zotero fields alone", async () => {
		const { app, notes, files } = vault({
			"lit/Keeper.md": { text: "Mine.\n", fm: { title: "Paper", zotero_item_key: "ABC", doi: "10.1/a", status: "reading", related: ["[[A]]"], rating: 3 } },
			"lit/Old.md": { text: "Theirs.\n", fm: { title: "Old", zotero_item_key: "XYZ", doi: "10.1/b", status: "done", related: ["[[B]]", "[[Keeper]]", "[[Old]]"], rating: 3, priority: "high", parent: "[[Keeper]]" } },
			"A.md": { text: "" },
			"B.md": { text: "" },
		});
		const plan = await planMerge(app, files.get("lit/Keeper.md")!, [files.get("lit/Old.md")!]);
		expect(plan.properties.original).toEqual({ status: "reading", related: ["[[A]]"], rating: 3 });
		expect(plan.properties.proposed).toEqual({
			status: ["reading", "done"], related: ["[[A]]", "[[B]]"], rating: 3, priority: "high",
		});
		expect(plan.properties.conflicts).toEqual(["status"]);
		expect(plan.properties.protectedValues).toMatchObject({ title: "Paper", zotero_item_key: "ABC", doi: "10.1/a" });
		expect(plan.properties.sources.related["[[B]]"]).toEqual([{ note: "Old", count: 1 }]);
		expect(changesProperties(plan.properties)).toBe(true);

		notes["lit/Keeper.md"].fm!.priority = "low";
		await executeMerge(app, plan, { ...all(plan), properties: { ...defaultProperties(plan.properties), status: "done" } });

		expect(notes["lit/Keeper.md"].fm).toMatchObject({
			title: "Paper", zotero_item_key: "ABC", doi: "10.1/a", status: "done", related: ["[[A]]", "[[B]]"], rating: 3, priority: "low",
		});
		expect(notes["lit/Keeper.md"].fm).not.toHaveProperty("parent");
	});

	it("writes the reviewed properties as approved and keeps the current value of a property left out", async () => {
		const { app, notes, files } = vault({
			"lit/Keeper.md": { text: "Mine.\n", fm: { title: "Paper", aliases: ["P"], tags: ["A"], status: "reading" } },
			"lit/Old.md": { text: "Theirs.\n", fm: { title: "Old paper", citekey: "Old24Paper", aliases: ["paper", "old24paper"], tags: ["a", "b"], status: "done" } },
		});
		const plan = await planMerge(app, files.get("lit/Keeper.md")!, [files.get("lit/Old.md")!]);
		// Tags match regardless of case. Neither the kept note's title nor the merged note's name or citation key becomes an alias.
		expect(plan.properties.proposed).toMatchObject({ aliases: ["P", "Old paper"], tags: ["A", "b"] });

		await executeMerge(app, plan, { ...all(plan), properties: { aliases: ["P"], tags: ["A", "b"] } });

		expect(notes["lit/Keeper.md"].fm).toMatchObject({ aliases: ["P"], tags: ["A", "b"], status: "reading" });
	});

	it("has nothing to review when the other notes add no properties", async () => {
		const { app, files } = vault({
			"lit/Keeper.md": { text: "Mine.\n", fm: { title: "Paper", aliases: ["Old"], status: "reading" } },
			"lit/Old.md": { text: "Theirs.\n", fm: { title: "Paper", status: "reading" } },
		});
		const plan = await planMerge(app, files.get("lit/Keeper.md")!, [files.get("lit/Old.md")!]);
		expect(changesProperties(plan.properties)).toBe(false);
	});

	it("does not copy text twice when the merge is repeated", async () => {
		const { app, notes, files } = vault({
			"lit/Keeper.md": { text: "Mine.\n" },
			"lit/Old.md": { text: "Theirs.\n" },
		});
		const plan = await planMerge(app, files.get("lit/Keeper.md")!, [files.get("lit/Old.md")!]);
		notes["lit/Keeper.md"].text = "Mine.\n\nTheirs.\n";
		const result = await executeMerge(app, plan, all(plan));
		expect(notes["lit/Keeper.md"].text).toBe("Mine.\n\nTheirs.\n");
		expect(result.merged).toHaveLength(1);
	});

	it("keeps a note whose links could not be redirected or that changed after the plan", async () => {
		const { app, notes, files, trashed } = vault({
			"lit/Keeper.md": { text: "Mine.\n" },
			"lit/Old.md": { text: "Theirs.\n" },
			"lit/Changed.md": { text: "Other.\n" },
			"Other.md": { text: "[[Old]]" },
		});
		const plan = await planMerge(app, files.get("lit/Keeper.md")!, [files.get("lit/Old.md")!, files.get("lit/Changed.md")!]);
		const process = app.vault.process as ReturnType<typeof vi.fn>;
		const original = process.getMockImplementation() as unknown as (entry: TFile, update: (text: string) => string) => Promise<string>;
		process.mockImplementation(async (entry: TFile, update: (text: string) => string) =>
			original(entry, entry.path === "Other.md" ? (text: string) => update(`Edited ${text}`) : update));
		notes["lit/Changed.md"].text = "Other, edited.\n";

		const result = await executeMerge(app, plan, all(plan));

		expect(trashed).toEqual([]);
		expect(result.kept.map((entry) => [entry.file.path, entry.reason])).toEqual([
			["lit/Old.md", "links in Other.md could not be redirected"],
			["lit/Changed.md", "it changed while the merge was being prepared"],
		]);
	});

	it("offers to remove a merged note's separate Zotero item only when no remaining note uses it", async () => {
		const { app, files } = vault({
			"lit/Keeper.md": { text: "Mine.\n", fm: { zotero_item_key: "ABC", zotero_library_uri: "library" } },
			"lit/Old.md": { text: "Theirs.\n", fm: { zotero_item_key: "OLD", zotero_library_uri: "library", title: "Old paper" } },
			"lit/Shared.md": { text: "Shared.\n", fm: { zotero_item_key: "SHR", zotero_library_uri: "library" } },
			"lit/Elsewhere.md": { text: "Uses it.\n", fm: { zotero_item_key: "SHR", zotero_library_uri: "library" } },
		});
		const plan = await planMerge(app, files.get("lit/Keeper.md")!, [files.get("lit/Old.md")!, files.get("lit/Shared.md")!]);
		expect(plan.sources.map((source) => source.zoteroItem)).toEqual([{ itemkey: "OLD", libraryURI: "library", title: "Old paper" }, undefined]);
		const result = await executeMerge(app, plan, all(plan, ["lit/Old.md"]));
		expect(result.zoteroItemsToTrash).toEqual([{ itemkey: "OLD", libraryURI: "library", title: "Old paper" }]);
	});
});
