import { TFile, parseLinktext } from "obsidian";
import type { App, FrontmatterLinkCache, ReferenceCache } from "obsidian";
import { collectValueSources } from "commons/properties/value-sources";
import type { FrontmatterValueSources } from "commons/properties/value-sources";
import { collectVaultMetadata } from "commons/properties/catalog";
import { deepMerge, findPropertyKey, findScalarConflicts, unionFrontmatter } from "commons/properties/merge";
import { METADATA_FIELDS } from "./metadataFields";

/** A paragraph, list item, heading section line or code block the user wrote in a note. */
export interface MergeBlock {
	text: string;
	/** True when a blank line separated it from the previous block in its note. */
	separated: boolean;
}

export interface MergeSource {
	file: TFile;
	/** The text the plan was made from; the note is not moved to trash if it changes. */
	content: string;
	/** User text the kept note does not already contain. */
	blocks: MergeBlock[];
	/** Notes, other than the merged notes, that link to this note. */
	linkedFrom: string[];
	/** Set when this note belongs to a different Zotero item from the kept note. */
	zoteroItem?: { itemkey: string; libraryURI?: string; title: string };
}

export interface PropertyMerge {
	/** The kept note's mergeable properties when the plan was made; a value the user changes since is left alone. */
	original: Record<string, unknown>;
	/**
	 * The kept note's mergeable properties after the merge: missing ones added, lists combined, and the
	 * merged notes' titles and aliases (not their names or citation keys) added as aliases. A single value the notes disagree on holds
	 * every candidate, the kept note's first.
	 */
	proposed: Record<string, unknown>;
	/** Single-value properties the notes disagree on; the user picks one. */
	conflicts: string[];
	/** Which notes each proposed value came from. */
	sources: FrontmatterValueSources;
	/** The kept note's Zotero fields, shown for reference; a merge never changes them. */
	protectedValues: Record<string, unknown>;
}

export interface MergePlan {
	keeper: TFile;
	sources: MergeSource[];
	properties: PropertyMerge;
}

export interface MergeChoices {
	/** Per source path: the indexes of the blocks to copy. */
	blocks: Map<string, Set<number>>;
	/** Source paths whose separate Zotero item should be moved to the Zotero trash. */
	trashZoteroItems: Set<string>;
	/** The property values the user approved; a property left out keeps the kept note's current value. */
	properties: Record<string, unknown>;
}

export interface MergeResult {
	merged: TFile[];
	/** Notes kept because something could not be completed safely, with the reason. */
	kept: Array<{ file: TFile; reason: string }>;
	copiedBlocks: number;
	redirectedLinks: number;
	changedProperties: number;
	/** The line of the merged-text marker in the kept note, for placing the cursor. */
	markerLine?: number;
	zoteroItemsToTrash: Array<{ itemkey: string; libraryURI: string; title: string }>;
}

const PLACEHOLDER = /^==(?:Delete this and write here\.|Don't delete the `persist` directives above and below\.)==\s*$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const FENCE = /^\s*(```|~~~)/;

function frontmatterEnd(content: string): number {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
	return match ? match[0].length : 0;
}

function normalized(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Split a note body into the blocks the user wrote. Saver's generated sections (the info callout,
 * the citation that follows it and the Zotero Note callout), template placeholders and rules are
 * left out, because the kept note has its own copies.
 */
export function userBlocks(content: string): MergeBlock[] {
	const lines = content.slice(frontmatterEnd(content)).split(/\r?\n/);
	const chunks: Array<{ lines: string[]; separated: boolean }> = [];
	let current: { lines: string[]; separated: boolean } | undefined;
	let blank = true;
	let fence: string | undefined;
	for (const line of lines) {
		if (fence) {
			current!.lines.push(line);
			if (line.trim().startsWith(fence)) fence = undefined;
			continue;
		}
		if (!line.trim()) {
			current = undefined;
			blank = true;
			continue;
		}
		const opensFence = line.match(FENCE);
		const quote = line.startsWith(">");
		const startsBlock = !current || opensFence || LIST_ITEM.test(line) || /^#{1,6}\s/.test(line) ||
			(quote !== current.lines[0].startsWith(">")) ||
			(LIST_ITEM.test(current.lines[0]) && !/^\s/.test(line));
		if (startsBlock) {
			current = { lines: [line], separated: blank || chunks.length === 0 };
			chunks.push(current);
		} else {
			current!.lines.push(line);
		}
		if (opensFence) fence = opensFence[1];
		blank = false;
	}
	const blocks: MergeBlock[] = [];
	let afterInfo = false;
	for (const chunk of chunks) {
		const text = chunk.lines.join("\n").replace(/\s+$/, "");
		const first = chunk.lines[0];
		if (/^>\s*\[!info\]/i.test(first)) {
			afterInfo = true;
			continue;
		}
		const citation = afterInfo && first.startsWith(">");
		afterInfo = false;
		if (citation || /^>\s*\[!note\][-+]?\s*(?:&nbsp;)?\s*Zotero Note/i.test(first)) continue;
		const kept = chunk.lines.filter((line) => !PLACEHOLDER.test(line.trim()));
		if (!kept.length || kept.every((line) => RULE.test(line))) continue;
		blocks.push({ text: kept.length === chunk.lines.length ? text : kept.join("\n").replace(/\s+$/, ""), separated: chunk.separated });
	}
	return blocks;
}

/** Notes linking to the file, from Obsidian's resolved link index. */
export function linkingNotes(app: App, file: TFile): string[] {
	return Object.entries(app.metadataCache.resolvedLinks ?? {})
		.filter(([source, destinations]) => source !== file.path && (destinations?.[file.path] ?? 0) > 0)
		.map(([source]) => source);
}

/**
 * Suggest the note to keep: the one with the most user text, then the most incoming links, then the
 * most recently modified.
 */
export interface KeeperEvidence {
	file: TFile;
	/** Characters of the user's own text. */
	text: number;
	/** Other notes linking to this one. */
	links: number;
	modified: number;
}

/** Evidence for choosing a note to keep, best candidate first. */
export async function rankKeepers(app: App, files: TFile[]): Promise<KeeperEvidence[]> {
	const scored = await Promise.all(files.map(async (file) => ({
		file,
		text: userBlocks(await app.vault.cachedRead(file)).reduce((sum, block) => sum + block.text.length, 0),
		links: linkingNotes(app, file).length,
		modified: file.stat?.mtime ?? 0,
	})));
	return scored.sort((a, b) => b.text - a.text || b.links - a.links || b.modified - a.modified);
}

export async function suggestKeeper(app: App, files: TFile[]): Promise<TFile> {
	return (await rankKeepers(app, files))[0].file;
}

function zoteroIdentity(app: App, file: TFile): { itemkey?: string; libraryURI?: string; title?: string } {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return {
		itemkey: typeof fm?.zotero_item_key === "string" && fm.zotero_item_key ? fm.zotero_item_key : undefined,
		libraryURI: typeof fm?.zotero_library_uri === "string" && fm.zotero_library_uri ? fm.zotero_library_uri : undefined,
		title: typeof fm?.title === "string" ? fm.title : undefined,
	};
}

/** Work out what merging the sources into the kept note would copy, redirect and remove. */
export async function planMerge(app: App, keeper: TFile, sources: TFile[]): Promise<MergePlan> {
	const merging = new Set([keeper.path, ...sources.map((file) => file.path)]);
	const seen = normalized(await app.vault.read(keeper));
	const copied = new Set<string>();
	const keeperIdentity = zoteroIdentity(app, keeper);
	const planned: MergeSource[] = [];
	for (const file of sources) {
		const content = await app.vault.read(file);
		const blocks = userBlocks(content).filter((block) => {
			const key = normalized(block.text);
			if (!key || seen.includes(key) || copied.has(key)) return false;
			copied.add(key);
			return true;
		});
		const identity = zoteroIdentity(app, file);
		const differentItem = !!identity.itemkey && (identity.itemkey !== keeperIdentity.itemkey ||
			(!!identity.libraryURI && !!keeperIdentity.libraryURI && identity.libraryURI !== keeperIdentity.libraryURI));
		// Offer to remove the Zotero item only when no note that stays in the vault refers to it.
		const stillUsed = differentItem && app.vault.getMarkdownFiles().some((other) => {
			if (merging.has(other.path) && other.path !== keeper.path) return false;
			const otherIdentity = zoteroIdentity(app, other);
			return otherIdentity.itemkey === identity.itemkey &&
				(!otherIdentity.libraryURI || !identity.libraryURI || otherIdentity.libraryURI === identity.libraryURI);
		});
		planned.push({
			file,
			content,
			blocks,
			linkedFrom: linkingNotes(app, file).filter((path) => !merging.has(path)),
			...(differentItem && !stillUsed ? { zoteroItem: { itemkey: identity.itemkey!, libraryURI: identity.libraryURI, title: identity.title ?? file.basename } } : {}),
		});
	}
	return { keeper, sources: planned, properties: planProperties(app, keeper, sources) };
}

/** Properties Saver writes from Zotero or uses to identify the item; each note keeps its own. */
const ZOTERO_FIELDS = new Set<string>([
	...METADATA_FIELDS, "citekey", "zotero_item_key", "zotero_library_uri", "book_title", "created_date", "modified_date",
]);
const NOT_MERGED = new Set<string>([...ZOTERO_FIELDS, "alias", "tag", "position"]);

const WIKILINK = /^!?\[\[([^\]|]*?)(?:\|[^\]]*)?\]\]$/;

/** Leave out values linking to the notes being merged: after the merge they would link the kept note to itself. */
function withoutMergedLinks(app: App, value: unknown, sourcePath: string, merging: Set<string>): unknown {
	if (Array.isArray(value)) return value.filter((entry) => withoutMergedLinks(app, entry, sourcePath, merging) !== undefined);
	const link = typeof value === "string" ? value.trim().match(WIKILINK) : null;
	return link && merging.has(linkTarget(app, link[1], sourcePath)?.path ?? "") ? undefined : value;
}

/**
 * A note's properties that a merge combines. A merged note's title and aliases become aliases, except the
 * kept note's own names and the merged note's own name and citation key.
 */
function mergeableProperties(app: App, file: TFile, merging: Set<string>, keeperNames?: Set<string>): Record<string, unknown> {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fm) as [string, unknown][]) {
		if (NOT_MERGED.has(key.toLowerCase())) continue;
		if (keeperNames && key.toLowerCase() === "aliases") continue;
		const kept = keeperNames ? withoutMergedLinks(app, value, file.path, merging) : value;
		if (kept !== undefined) result[key] = kept;
	}
	if (keeperNames) {
		// The merged note's name and citation key are not kept: links to it are redirected, and the key belongs to the trashed note.
		const ownKeys = new Set([file.basename, ...stringList(fm.citekey)].map((name) => name.toLowerCase()));
		const aliases = union([...stringList(fm.title), ...stringList(fm.aliases)])
			.filter((alias) => !keeperNames.has(alias.toLowerCase()) && !ownKeys.has(alias.toLowerCase()));
		if (aliases.length) result.aliases = aliases;
	}
	return result;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function planProperties(app: App, keeper: TFile, sources: TFile[]): PropertyMerge {
	const merging = new Set([keeper.path, ...sources.map((file) => file.path)]);
	const keeperFm = app.metadataCache.getFileCache(keeper)?.frontmatter ?? {};
	const keeperNames = new Set([keeper.basename, ...stringList(keeperFm.title)].map((name) => name.toLowerCase()));
	const original = mergeableProperties(app, keeper, merging);
	const notes = [{ note: keeper.basename, frontmatter: original },
		...sources.map((file) => ({ note: file.basename, frontmatter: mergeableProperties(app, file, merging, keeperNames) }))];
	const merged = unionFrontmatter(notes.map((note) => note.frontmatter), { gatherConflicts: true });
	const gathered = findScalarConflicts(collectVaultMetadata(app, [keeper, ...sources]), merged);
	const proposed: Record<string, unknown> = {};
	const conflicts: string[] = [];
	for (const [key, value] of Object.entries(merged)) {
		if (gathered[key]) conflicts.push(key);
		proposed[key] = gathered[key] ?? (key.toLowerCase() === "aliases" ? union(stringList(value)) : value);
	}
	const protectedValues = Object.fromEntries(Object.entries(keeperFm as Record<string, unknown>)
		.filter(([key]) => ZOTERO_FIELDS.has(key.toLowerCase())));
	return { original, proposed, conflicts, sources: collectValueSources(notes), protectedValues };
}

/** True when the merge would change at least one of the kept note's properties, so there is something to review. */
export function changesProperties(plan: PropertyMerge): boolean {
	return plan.conflicts.length > 0 || Object.entries(plan.proposed).some(([key, value]) => !same(value, plan.original[key]));
}

/** The values to write when the user is not asked: everything proposed, with the kept note's value for each conflict. */
export function defaultProperties(plan: PropertyMerge): Record<string, unknown> {
	return Object.fromEntries(Object.entries(plan.proposed).map(([key, value]) =>
		[key, plan.conflicts.includes(key) && Array.isArray(value) ? value[0] : value]));
}

/**
 * Write the approved values, leaving alone any property the user changed in the kept note since the plan;
 * a changed list still gains the approved values. Zotero fields are never written.
 */
function applyProperties(fm: Record<string, unknown>, plan: PropertyMerge, approved: Record<string, unknown>): number {
	let changed = 0;
	for (const [name, value] of Object.entries(approved)) {
		if (ZOTERO_FIELDS.has(name.toLowerCase())) continue;
		const key = findPropertyKey(fm, name) ?? name;
		const current = fm[key];
		const next = same(current, plan.original[name]) ? value
			: Array.isArray(current) && Array.isArray(value) ? deepMerge(value, current, key) : current;
		if (same(next, current)) continue;
		fm[key] = next;
		changed++;
	}
	return changed;
}

function joinBlocks(blocks: MergeBlock[]): string {
	return blocks.map((block, index) => `${index === 0 ? "" : block.separated ? "\n\n" : "\n"}${block.text}`).join("");
}

/**
 * Insert the copied text into the kept note's own text: in place of the template placeholder when it is
 * still there, else before the Zotero Note section or transcript, else at the end.
 */
export function insertMergedText(content: string, section: string): { content: string; line: number } {
	const start = frontmatterEnd(content);
	const body = content.slice(start);
	const lines = body.split("\n");
	const placeholder = lines.findIndex((line) => PLACEHOLDER.test(line.trim()));
	let index: number;
	let remove = 0;
	if (placeholder >= 0) {
		index = placeholder;
		while (placeholder + remove < lines.length && PLACEHOLDER.test(lines[placeholder + remove].trim())) remove++;
	} else {
		const note = lines.findIndex((line) => /^>\s*\[!note\][-+]?\s*(?:&nbsp;)?\s*Zotero Note/i.test(line));
		if (note >= 0) {
			index = note > 0 && RULE.test(lines[note - 1]) ? note - 1 : note;
		} else {
			const transcript = lines.findIndex((line, i) => i > 0 && /^#\s+.*transcript/i.test(line));
			index = transcript >= 0 ? transcript : lines.length;
		}
		while (index > 0 && !lines[index - 1].trim()) index--;
	}
	const before = lines.slice(0, index);
	const after = lines.slice(index + remove);
	const inserted = [...(before.length && before[before.length - 1].trim() ? [""] : []), ...section.split("\n"),
		...(after.length && after[0].trim() ? [""] : [])];
	const prefix = content.slice(0, start).split("\n").length - 1;
	const line = prefix + before.length + (before.length && before[before.length - 1].trim() ? 1 : 0);
	const next = content.slice(0, start) + [...before, ...inserted, ...after].join("\n");
	return { content: content.endsWith("\n") && !next.endsWith("\n") ? `${next}\n` : next, line };
}

function linkTarget(app: App, link: string, sourcePath: string): TFile | null {
	return app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path, sourcePath);
}

/** The same link, pointing at the kept note. Display text, headings and block references are kept. */
export function redirectedLink(app: App, original: string, link: string, to: TFile, sourcePath: string): string | undefined {
	const { subpath } = parseLinktext(link);
	const wiki = original.match(/^(!?\[\[)([^\]|]*?)(\|[^\]]*)?\]\]$/);
	if (wiki) return `${wiki[1]}${app.metadataCache.fileToLinktext(to, sourcePath, true)}${subpath}${wiki[3] ?? ""}]]`;
	const markdown = original.match(/^(!?\[[^\]]*\]\()(<)?([^)>]*?)(>)?(\s+"[^"]*")?\)$/);
	if (!markdown) return undefined;
	const target = markdown[3];
	const hash = target.indexOf("#");
	const rawPath = hash >= 0 ? target.slice(0, hash) : target;
	const rawSubpath = hash >= 0 ? target.slice(hash) : "";
	let path = rawPath.includes("/") || rawPath.includes("%2F") ? to.path : to.name;
	if (!/\.md$/i.test(decodeURIComponent(rawPath))) path = path.replace(/\.md$/i, "");
	const written = markdown[2] ? path : path.replace(/ /g, "%20");
	return `${markdown[1]}${markdown[2] ?? ""}${written}${rawSubpath}${markdown[4] ?? ""}${markdown[5] ?? ""})`;
}

function replaceFrontmatterValue(value: unknown, original: string, replacement: string): { value: unknown; count: number } {
	if (typeof value === "string") return value === original ? { value: replacement, count: 1 } : { value, count: 0 };
	if (Array.isArray(value)) {
		let count = 0;
		const next = value.map((entry) => {
			const result = replaceFrontmatterValue(entry, original, replacement);
			count += result.count;
			return result.value;
		});
		return { value: next, count };
	}
	return { value, count: 0 };
}

/**
 * Point every link to `from` at `to`. Each edit is checked against the current file text, so a note
 * changed since Obsidian indexed it is reported instead of being edited at the wrong place.
 */
export async function redirectLinks(app: App, from: TFile, to: TFile, sources: string[]): Promise<{ links: number; failed: string[] }> {
	let links = 0;
	const failed: string[] = [];
	for (const path of sources) {
		const source = app.vault.getAbstractFileByPath(path);
		if (!(source instanceof TFile)) continue;
		const cache = app.metadataCache.getFileCache(source);
		const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])]
			.filter((ref: ReferenceCache) => linkTarget(app, ref.link, source.path)?.path === from.path)
			.sort((a, b) => b.position.start.offset - a.position.start.offset);
		const properties = (cache?.frontmatterLinks ?? [])
			.filter((ref: FrontmatterLinkCache) => linkTarget(app, ref.link, source.path)?.path === from.path);
		try {
			if (references.length) {
				await app.vault.process(source, (content) => {
					let next = content;
					for (const ref of references) {
						const { offset: start } = ref.position.start;
						const { offset: end } = ref.position.end;
						const replacement = redirectedLink(app, ref.original, ref.link, to, source.path);
						if (next.slice(start, end) !== ref.original || replacement === undefined) {
							throw new Error(`${source.path} changed since Obsidian indexed it.`);
						}
						next = next.slice(0, start) + replacement + next.slice(end);
					}
					return next;
				});
				links += references.length;
			}
			if (properties.length) {
				await app.fileManager.processFrontMatter(source, (fm: Record<string, unknown>) => {
					for (const ref of properties) {
						const replacement = `[[${app.metadataCache.fileToLinktext(to, source.path, true)}${parseLinktext(ref.link).subpath}${ref.displayText && ref.displayText !== ref.link ? `|${ref.displayText}` : ""}]]`;
						const key = ref.key.split(".")[0];
						const result = replaceFrontmatterValue(fm[key], ref.original, replacement);
						if (!result.count) throw new Error(`${source.path} properties changed since Obsidian indexed them.`);
						fm[key] = result.value;
						links += result.count;
					}
				});
			}
		} catch (error) {
			console.error(`Could not redirect links in ${source.path}`, error);
			failed.push(source.path);
		}
	}
	return { links, failed };
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
	return typeof value === "string" && value.trim() ? [value] : [];
}

function union(...lists: string[][]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const entry of lists.flat()) {
		const key = entry.trim().toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

/**
 * Merge the plan's sources into the kept note: copy the chosen text, write the approved properties,
 * redirect links, then move each merged note to trash.
 * Every step can be repeated safely: copied text is not copied twice, and a note is moved to trash
 * only after its links were redirected and only if it did not change since the plan was made.
 */
export async function executeMerge(app: App, plan: MergePlan, choices: MergeChoices, today = new Date()): Promise<MergeResult> {
	const result: MergeResult = { merged: [], kept: [], copiedBlocks: 0, redirectedLinks: 0, changedProperties: 0, zoteroItemsToTrash: [] };
	// The kept note's own links to the merged notes are redirected first, while Obsidian's index of it is current.
	const keeperFailed = new Set<string>();
	for (const source of plan.sources) {
		const own = await redirectLinks(app, source.file, plan.keeper, [plan.keeper.path]);
		result.redirectedLinks += own.links;
		if (own.failed.length) keeperFailed.add(source.file.path);
	}
	const date = today.toISOString().slice(0, 10);
	const sections: string[] = [];
	for (const source of plan.sources) {
		const chosen = choices.blocks.get(source.file.path) ?? new Set<number>();
		const blocks = source.blocks.filter((_, index) => chosen.has(index));
		if (!blocks.length) continue;
		sections.push(`**Merged from ${source.file.basename} on ${date}. Tidy this text, then remove this line.**\n\n${joinBlocks(blocks)}`);
		result.copiedBlocks += blocks.length;
	}
	if (sections.length) {
		await app.vault.process(plan.keeper, (content) => {
			const current = normalized(content);
			const missing = sections.filter((section) => !current.includes(normalized(section.split("\n\n").slice(1).join("\n\n"))));
			if (!missing.length) return content;
			const inserted = insertMergedText(content, missing.join("\n\n"));
			result.markerLine = inserted.line;
			return inserted.content;
		});
	}
	if (Object.keys(choices.properties).length) {
		await app.fileManager.processFrontMatter(plan.keeper, (fm: Record<string, unknown>) => {
			result.changedProperties = applyProperties(fm, plan.properties, choices.properties);
		});
	}
	for (const source of plan.sources) {
		const redirect = await redirectLinks(app, source.file, plan.keeper, source.linkedFrom);
		result.redirectedLinks += redirect.links;
		if (keeperFailed.has(source.file.path)) redirect.failed.unshift(plan.keeper.path);
		if (redirect.failed.length) {
			result.kept.push({ file: source.file, reason: `links in ${redirect.failed.join(", ")} could not be redirected` });
			continue;
		}
		const current = app.vault.getAbstractFileByPath(source.file.path);
		if (!(current instanceof TFile) || await app.vault.read(current) !== source.content) {
			result.kept.push({ file: source.file, reason: "it changed while the merge was being prepared" });
			continue;
		}
		await app.fileManager.trashFile(current);
		result.merged.push(source.file);
		if (source.zoteroItem?.libraryURI && choices.trashZoteroItems.has(source.file.path)) {
			result.zoteroItemsToTrash.push({ itemkey: source.zoteroItem.itemkey, libraryURI: source.zoteroItem.libraryURI, title: source.zoteroItem.title });
		}
	}
	return result;
}
