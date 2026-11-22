import { App, normalizePath, Notice, parseLinktext, TFile } from "obsidian";
import type { ReferenceCache } from "obsidian";
import { buildAliases, buildAttachmentLinks, buildLitNoteFrontmatter } from "./buildLitNote";
import { findIdenticalAttachments } from "./attachmentIdentity";
import type { IdenticalAttachment } from "./attachmentIdentity";
import type { AttachmentReviewRow, CitekeyConflictDetails, DecisionButton, NoteDecision } from "./decisionModal";
import { getLitNoteFiles } from "./litNoteFinder";
import type { ZoteroItemPayload } from "./types";
import type { LitNoteWriterSettings } from "./writeLitNote";

const START = "<!-- zotero-attachments:start -->";
const END = "<!-- zotero-attachments:end -->";
const METADATA_FIELDS = [
	"title", "authors", "publication_date", "zotero_item_type", "doi", "url",
	"publication", "publisher", "isbn", "zotero_collections", "zotero_tags",
] as const;

export interface SyncResult {
	status: "updated" | "skipped" | "missing" | "error" | "set-zotero-key" | "prepared";
	citekey: string;
	error?: string;
	noteCitekey?: string;
	expectedZoteroKey?: string;
	snapshot?: string;
	notePath?: string;
	identicalAttachments?: IdenticalAttachment[];
	deferUntilChanged?: boolean;
}

type Prompt = (title: string, message: string, buttons: DecisionButton[], review?: AttachmentReviewRow[], conflict?: CitekeyConflictDetails) => Promise<NoteDecision>;

const ATTACHMENT = /^\*\*(?:\[\[[^\]]+\|(?:PDF|HTM|DOC|PPT|EPUB|TXT)\]\]|\[(?:PDF|HTM|DOC|PPT|EPUB|TXT)\]\([^)]+\)|(?:PDF|HTM|DOC|PPT|EPUB|TXT|Attachment) unavailable in vault)\*\*$/;

function value(value: unknown): string {
	return JSON.stringify(value) ?? "(absent)";
}

function header(content: string): string | undefined {
	return content.split(/\r?\n/).find((line) => /^> \[!info\]/i.test(line));
}

function managedHeader(line: string, links: string[], allowLegacy: boolean): string {
	const start = line.indexOf(START);
	const end = line.indexOf(END);
	if (start !== -1 || end !== -1) {
		if (start < 0 || end < start || line.indexOf(START, start + START.length) !== -1 ||
			line.indexOf(END, end + END.length) !== -1) {
			throw new Error("The managed attachment markers are invalid; no attachment links were changed.");
		}
		const attachmentText = links.length ? ` | ${links.join(" | ")}` : "";
		return line.slice(0, start) + START + attachmentText + END + line.slice(end + END.length);
	}
	if (!allowLegacy) {
		throw new Error("The note has no managed attachment markers; update it manually to confirm adoption.");
	}
	const segments = line.split(" | ");
	const kept = segments.filter((segment, index) => index === 0 || !ATTACHMENT.test(segment));
	return kept.join(" | ") + START + (links.length ? ` | ${links.join(" | ")}` : "") + END;
}

function existingAttachmentLinks(line: string): string[] {
	const start = line.indexOf(START);
	const end = line.indexOf(END);
	if (start !== -1 || end !== -1) {
		if (start < 0 || end < start || line.indexOf(START, start + START.length) !== -1 ||
			line.indexOf(END, end + END.length) !== -1) {
			throw new Error("The managed attachment markers are invalid; no attachment links were changed.");
		}
		return line.slice(start + START.length, end).split(" | ").filter(Boolean);
	}
	return line.split(" | ").slice(1).filter((segment) => ATTACHMENT.test(segment));
}

function subtractLinks(left: string[], right: string[]): string[] {
	const remaining = [...right];
	return left.filter((link) => {
		const index = remaining.indexOf(link);
		if (index < 0) return true;
		remaining.splice(index, 1);
		return false;
	});
}

function attachmentLinkPath(link: string): string | undefined {
	const match = link.match(/^\*\*(?:\[\[([^|\]]+)(?:\|[^\]]*)?\]\]|\[[^\]]+\]\(([^)]+)\))\*\*$/);
	return match?.[1] ?? (match?.[2] ? decodeURIComponent(match[2]) : undefined);
}

function backlinkWarning(app: App, filePath: string): string {
	const links = app.metadataCache.resolvedLinks;
	if (!links) return "Obsidian's link index is unavailable. Check links to this note before renaming it.";
	const sources = Object.entries(links)
		.filter(([, destinations]) => (destinations[filePath] ?? 0) > 0)
		.map(([source]) => source);
	if (!sources.length) return "No indexed links to this note were found. External or unindexed links may still exist.";
	return `${sources.length} indexed note${sources.length === 1 ? "" : "s"} link to this note. Obsidian does not expose whether automatic link updates are enabled; check that setting before renaming. External or unindexed links may also exist.`;
}

function validKey(key: string): boolean {
	return !!key && key !== "." && key !== ".." &&
		!/[/\\<>:"|?*]/.test(key) && !Array.from(key).some((char) => char.charCodeAt(0) < 32) &&
		!/[. ]$/.test(key) &&
		!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(key);
}

function isStringArray(input: unknown): input is string[] {
	return Array.isArray(input) && input.every((entry: unknown) => typeof entry === "string");
}

export async function syncLitNote(
	app: App,
	settings: LitNoteWriterSettings,
	item: ZoteroItemPayload,
	mode: "auto" | "metadata",
	prompt: Prompt,
	options: {
		prepareOnly?: boolean;
		expectedContent?: string;
		expectedIdenticalAttachments?: IdenticalAttachment[];
		beforeApply?: () => Promise<void> | void;
		trashIdenticalAttachments?: (pairs: IdenticalAttachment[], notePath: string) => Promise<void>;
	} = {}
): Promise<SyncResult> {
	const citekey = item.citekey?.trim() ?? "";
	const result = (status: SyncResult["status"], error?: string): SyncResult =>
		({ status, citekey, ...(error ? { error } : {}) });
	if (!validKey(citekey) || !item.itemkey || !item.libraryURI) {
		return result("error", "A valid citation key, Zotero item key, and library identity are required.");
	}

	const matchingKey = getLitNoteFiles(app, settings.litNotesFolder).filter((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && fm.zotero_item_key === item.itemkey;
	});
	let candidates = matchingKey.filter((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		return !fm?.zotero_library_uri || fm.zotero_library_uri === item.libraryURI;
	});
	let reassociating = false;
	if (!candidates.length && mode === "metadata" && matchingKey.length === 1) {
		candidates = matchingKey;
		reassociating = true;
	}
	if (!candidates.length && mode === "metadata" && matchingKey.length > 1) {
		return result("error", "More than one literature note has this Zotero item key; no association was changed.");
	}
	if (!candidates.length) return result("missing");
	if (candidates.length !== 1) return result("error", "More than one literature note matches this Zotero item.");
	const file = candidates[0];
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return result("error", "The note's frontmatter is not indexed yet.");
	const originalValues = Object.fromEntries(Object.entries(fm).map(([key, current]) => [key, value(current)]));
	const legacy = !fm.zotero_library_uri;
	const folder = file.parent?.path ?? "";
	const target = normalizePath(folder ? `${folder}/${citekey}.md` : `${citekey}.md`);
	const content = await app.vault.read(file);
	if (options.expectedContent !== undefined && content !== options.expectedContent) {
		return result("error", "The note changed while the update was pending; retry.");
	}
	const oldHeader = header(content);
	if (!oldHeader) return result("error", "The note has no Zotero info callout; attachment links were not changed.");
	const noteKey = typeof fm.citekey === "string" ? fm.citekey.trim() : "";
	if (noteKey && noteKey !== citekey) {
		const check = item.citationKeyCheck;
		if (!check || check.citekey !== noteKey || !Array.isArray(check.matches) ||
			check.matches.some((match) => !match || typeof match.title !== "string" ||
				typeof match.citekey !== "string" || typeof match.libraryURI !== "string" ||
				typeof match.itemkey !== "string")) {
			return result("error", "Could not verify whether the Obsidian citation key is already used in Zotero. Retry the update.");
		}
		const association = reassociating
			? `\n\nThe note records a different Zotero library. Confirm both describe the same work.`
			: legacy ? `\n\nThe note doesn't record its Zotero library. Confirm it matches the item in ${item.libraryName || item.libraryURI}.` : "";
		const duplicates = check.matches.length
			? `\n\n${check.matches.length === 1 ? "Another Zotero item uses" : "Other Zotero items use"} the same or a similar citation key:\n${check.matches.slice(0, 3).map((match) =>
				`- ${match.title} (${match.citekey}; ${match.libraryURI === item.libraryURI ? "same library" : "another library"})`).join("\n")}${check.matches.length > 3 ? `\n- And ${check.matches.length - 3} more` : ""}\nUsing it may make citations ambiguous.`
			: "";
		const buttons: DecisionButton[] = [
			...(validKey(noteKey) ? [{ label: "Use Obsidian citekey", value: "use-obsidian" as const }] : []),
			{ label: "Use Zotero citekey", value: "use-zotero", cta: true },
			{ label: "Cancel", value: "cancel" },
		];
		const choice = await prompt("Citekeys differ",
			`Search Zotero for the item key.\n\nUse Zotero: review changes to the note and its links. ${validKey(noteKey) ? "Use Obsidian: Zotero changes now, possibly renaming files; later cancellation won't undo it." : ""}${association}${duplicates}`,
			buttons, undefined, { title: item.title, itemkey: item.itemkey, libraryURI: item.libraryURI, notePath: file.path, noteCitekey: noteKey, zoteroCitekey: citekey });
		if (choice === "use-obsidian") {
			const noteTarget = normalizePath(folder ? `${folder}/${noteKey}.md` : `${noteKey}.md`);
			const noteCollision = app.vault.getAbstractFileByPath(noteTarget);
			if (noteCollision && noteCollision !== file) return result("error", `Cannot rename note: ${noteTarget} already exists. Zotero was not changed.`);
			if (reassociating) {
				const confirmed = await prompt("Confirm Zotero item",
					`This Obsidian note records a different Zotero library. Confirm that it and "${item.title}" (Zotero item key ${item.itemkey}, ${item.libraryName || item.libraryURI}) describe the same work before changing Zotero.`,
					[{ label: "Continue", value: "create" }, { label: "Cancel", value: "cancel" }]);
				if (confirmed !== "create") return result("skipped");
			}
			if (await app.vault.read(file) !== content) {
				return result("error", "The note changed while the decision was pending; retry.");
			}
			return { status: "set-zotero-key", citekey, noteCitekey: noteKey, expectedZoteroKey: citekey, snapshot: content };
		}
		if (choice !== "use-zotero") return result("skipped");
	}
	const collision = app.vault.getAbstractFileByPath(target);
	if (collision && collision !== file) return result("error", `Cannot rename note: ${target} already exists.`);
	const attachmentLinks = buildAttachmentLinks(app, item, target, false);
	if (attachmentLinks.some((link) => link.includes("unavailable in vault"))) {
		buildAttachmentLinks(app, item, target);
		return result("error", "Some Zotero attachments are unavailable in the vault; existing note links were preserved. Retry when the files are available.");
	}
	let oldLinks: string[];
	try {
		oldLinks = existingAttachmentLinks(oldHeader);
	} catch (error) {
		return result("error", error instanceof Error ? error.message : String(error));
	}
	const noteOnlyLinks = subtractLinks(oldLinks, attachmentLinks);
	const zoteroOnlyLinks = subtractLinks(attachmentLinks, oldLinks);
	const resolveAttachment = (link: string, sourcePath: string): TFile | null => {
		const path = attachmentLinkPath(link);
		const candidate = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null;
		return candidate instanceof TFile ? candidate : null;
	};
	const noteOnlyFiles = [...new Map(noteOnlyLinks.flatMap((link) => {
		const candidate = resolveAttachment(link, file.path);
		return candidate ? [[candidate.path, candidate] as const] : [];
	})).values()];
	const noteOnlyPaths = new Set(noteOnlyFiles.map((candidate) => candidate.path));
	const noteOnlyLinkPaths = new Set(noteOnlyLinks.flatMap((link) => {
		const linkPath = attachmentLinkPath(link);
		return linkPath ? [parseLinktext(linkPath).path] : [];
	}));
	const zoteroFiles = [...new Map(attachmentLinks.flatMap((link) => {
		const candidate = resolveAttachment(link, target);
		return candidate ? [[candidate.path, candidate] as const] : [];
	})).values()];
	let identicalAttachments: IdenticalAttachment[];
	try {
		identicalAttachments = noteOnlyFiles.length && zoteroFiles.length
			? await findIdenticalAttachments(app, noteOnlyFiles, zoteroFiles)
			: [];
	} catch (error) {
		return result("error", `Could not compare attachment files: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (options.expectedIdenticalAttachments &&
		JSON.stringify(identicalAttachments) !== JSON.stringify(options.expectedIdenticalAttachments)) {
		return result("error", "Attachment files changed while the update was pending; retry.");
	}
	const identicalNotePaths = new Set(identicalAttachments.map((pair) => pair.note.path));
	const identicalZoteroPaths = new Set(identicalAttachments.map((pair) => pair.zotero.path));
	const automaticRemoved = noteOnlyLinks.filter((link) => {
		const candidate = resolveAttachment(link, file.path);
		return candidate && identicalNotePaths.has(candidate.path);
	});
	const removedLinks = subtractLinks(noteOnlyLinks, automaticRemoved);
	const addedLinks = zoteroOnlyLinks.filter((link) => {
		const candidate = resolveAttachment(link, target);
		return !candidate || !identicalZoteroPaths.has(candidate.path);
	});
	const keptLinks: string[] = [];
	const keptManagedLinks: string[] = [];
	const cached = app.metadataCache.getFileCache(file);
	const references: ReferenceCache[] = [...(cached?.links ?? []), ...(cached?.embeds ?? [])];
	const headerLine = content.split(/\r?\n/).findIndex((line) => line === oldHeader);
	const headerStart = content.split(/\r?\n/).slice(0, headerLine)
		.reduce((offset, line) => offset + line.length + (content.slice(offset + line.length, offset + line.length + 2) === "\r\n" ? 2 : 1), 0);
	const managedRanges: Array<{ start: number; end: number }> = [];
	const markerStart = oldHeader.indexOf(START);
	const markerEnd = oldHeader.indexOf(END);
	if (markerStart >= 0 && markerEnd >= markerStart) {
		managedRanges.push({ start: headerStart + markerStart, end: headerStart + markerEnd + END.length });
	} else {
		let offset = headerStart;
		for (const segment of oldHeader.split(" | ")) {
			if (ATTACHMENT.test(segment)) managedRanges.push({ start: offset, end: offset + segment.length });
			offset += segment.length + 3;
		}
	}
	const outsideAttachments = references.filter((reference) => {
		const path = parseLinktext(reference.link).path;
		const handled = reference.position.start.line === headerLine && managedRanges.some((range) =>
			reference.position.start.offset >= range.start && reference.position.end.offset <= range.end);
		return !handled &&
			!/^https?:/i.test(path) && /\.(?:pdf|html|docx|pptx|epub|txt)$/i.test(path);
	});
	const attachmentFiles = outsideAttachments.length ? zoteroFiles : [];
	const bodyEdits: Array<{ start: number; end: number; original: string; replacement: string }> = [];
	const headerEdits: typeof bodyEdits = [];
	const bodyChoices: Array<{ reference: ReferenceCache; eligible: TFile[]; existing: TFile | null }> = [];
	for (const reference of outsideAttachments) {
		const { path } = parseLinktext(reference.link);
		const existing = app.metadataCache.getFirstLinkpathDest(path, file.path);
		if (existing && attachmentFiles.some((candidate) => candidate.path === existing.path)) continue;
		if (existing ? !noteOnlyPaths.has(existing.path) : !noteOnlyLinkPaths.has(path)) continue;
		const identical = existing && identicalAttachments.find((pair) => pair.note.path === existing.path);
		const survivor = identical && zoteroFiles.find((candidate) => candidate.path === identical.zotero.path);
		if (survivor) {
			const start = reference.position.start.offset;
			const end = reference.position.end.offset;
			if (content.slice(start, end) !== reference.original) {
				return result("error", "Obsidian's link index is out of date; retry after the note is indexed.");
			}
			const { subpath } = parseLinktext(reference.link);
			const replacement = app.fileManager.generateMarkdownLink(survivor, target, subpath, reference.displayText);
			const edit = { start, end, original: reference.original, replacement: reference.original.startsWith("!") ? `!${replacement}` : replacement };
			(reference.position.start.line === headerLine ? headerEdits : bodyEdits).push(edit);
			continue;
		}
		const eligible = attachmentFiles.filter((candidate) => candidate.extension.toLowerCase() === path.split(".").pop()?.toLowerCase());
		bodyChoices.push({ reference, eligible, existing });
	}
	const selectedAdditions: string[] = [];
	const removedSelected: string[] = [...automaticRemoved];
	const reviewFile = (link: string, sourcePath: string, role: string): Array<{ path: string; modified?: number; role: string }> => {
		const path = attachmentLinkPath(link);
		const candidate = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null;
		return candidate instanceof TFile ? [{ path: candidate.path, modified: candidate.stat?.mtime, role }] : [];
	};
	const review: AttachmentReviewRow[] = [
		...removedLinks.map((link): AttachmentReviewRow => ({
			kind: "note", label: `Only in the note: ${attachmentLinkPath(link) ?? "unavailable attachment"}`,
			options: [{ label: "Keep this link in the note", value: "keep" }, { label: "Remove this link from the note", value: "remove" }],
			defaultValue: "keep",
			files: reviewFile(link, file.path, "Note attachment"),
		})),
		...addedLinks.map((link): AttachmentReviewRow => ({
			kind: "add", label: `Only in Zotero: ${attachmentLinkPath(link) ?? "unavailable attachment"}`,
			options: [{ label: "Add a link to the note", value: "add" }, { label: "Do not add a link", value: "skip" }],
			defaultValue: "add",
			files: reviewFile(link, target, "Zotero attachment"),
		})),
		...bodyChoices.map(({ reference, eligible, existing }): AttachmentReviewRow => ({
			kind: "body", label: `Another note link to ${parseLinktext(reference.link).path}`,
			options: [{ label: "Keep this note link unchanged", value: "keep" }, ...eligible.map((candidate, index) => ({
				label: `Change this note link to ${candidate.path}`, value: String(index),
			}))],
			defaultValue: "keep",
			files: [
				...(existing instanceof TFile ? [{ path: existing.path, modified: existing.stat?.mtime, role: "Current note link" }] : []),
				...eligible.map((candidate) => ({ path: candidate.path, modified: candidate.stat?.mtime, role: "Zotero attachment" })),
			],
		})),
		...(item.zoteroChanges?.attachmentMoves ?? []).map((move): AttachmentReviewRow => ({
			kind: "zotero", label: `Already changed in Zotero (attachment item key ${move.itemkey}): ${move.from} → ${move.to}`,
			options: [{ label: "Already changed", value: "changed" }],
			defaultValue: "changed",
		})),
	];
	const cancelNote = item.zoteroChanges ? "\n\nCancel leaves the Zotero changes in place; no proposed Obsidian note changes are applied." : "\n\nCancel makes no changes.";
	if (review.length) {
		const alreadyChanged = item.zoteroChanges
			? `Already changed in Zotero: citekey ${item.zoteroChanges.previousCitekey} → ${citekey}; ${item.zoteroChanges.attachmentMoves.length} verified attachment file move(s) or rename(s). These are not undone if you cancel.\n\n`
			: "";
		const summary = await prompt("Attachment links differ",
			`${alreadyChanged}Obsidian note: ${file.path}\n\n${oldLinks.length - removedLinks.length} attachment link(s) match; ${removedLinks.length} link(s) are only in the Obsidian note; ${addedLinks.length} Zotero attachment(s) are not linked in the note. ${bodyChoices.length} other note link(s) need review.\n\nReview the differences before changing the Obsidian note. Attachment files in Zotero are not changed by this review.${cancelNote}`,
			[{ label: "Review differences", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (summary !== "create") return result("skipped");
		const choice = await prompt("Review attachment links",
			`Choose how to update the note's links. These choices do not change files or Zotero attachments. Unrelated links are left alone.${cancelNote}`,
			[{ label: "Continue", value: "create", cta: true }, { label: "Cancel", value: "cancel" }], review);
		if (choice === "cancel") return result("skipped");
		if (!choice.startsWith("review:")) return result("error", "The attachment review was not completed; no note changes were made.");
		let selections: unknown;
		try {
			selections = JSON.parse(choice.slice("review:".length));
		} catch {
			return result("error", "The attachment review was invalid; no note changes were made.");
		}
		if (!isStringArray(selections) || selections.length !== review.length ||
			selections.some((selection, index) => !review[index].options.some((option) => option.value === selection))) {
			return result("error", "The attachment review changed; no note changes were made.");
		}
		removedLinks.forEach((link, index) => {
			if (selections[index] === "keep") {
				keptLinks.push(link);
				keptManagedLinks.push(link);
			} else removedSelected.push(link);
		});
		addedLinks.forEach((link, index) => {
			if (selections[removedLinks.length + index] === "add") selectedAdditions.push(link);
			else keptLinks.push(`Zotero attachment not added: ${link}`);
		});
		for (let index = 0; index < bodyChoices.length; index++) {
			const { reference, eligible } = bodyChoices[index];
			const decision = selections[removedLinks.length + addedLinks.length + index];
			if (decision === "keep") {
				keptLinks.push(reference.original);
				continue;
			}
			const selected = eligible[Number(decision)];
			if (!selected) return result("error", "The selected attachment is no longer available; retry.");
			const { subpath } = parseLinktext(reference.link);
			const start = reference.position.start.offset;
			const end = reference.position.end.offset;
			if (content.slice(start, end) !== reference.original) {
				return result("error", "Obsidian's link index is out of date; retry after the note is indexed.");
			}
			const replacement = app.fileManager.generateMarkdownLink(selected, target, subpath, reference.displayText);
			const edit = { start, end, original: reference.original, replacement: reference.original.startsWith("!") ? `!${replacement}` : replacement };
			(reference.position.start.line === headerLine ? headerEdits : bodyEdits).push(edit);
		}
	}
	if (legacy && mode === "auto" && !item.zoteroChanges && noteKey === citekey && file.path === target &&
		!removedLinks.length && !addedLinks.length && !automaticRemoved.length && !bodyEdits.length && !headerEdits.length && !keptLinks.length) return result("skipped");
	let editedHeader = oldHeader;
	for (const edit of headerEdits.sort((a, b) => b.start - a.start)) {
		const start = edit.start - headerStart;
		const end = edit.end - headerStart;
		editedHeader = editedHeader.slice(0, start) + edit.replacement + editedHeader.slice(end);
	}
	let newHeader: string;
	try {
		newHeader = managedHeader(editedHeader, [...subtractLinks(attachmentLinks, addedLinks), ...selectedAdditions, ...keptManagedLinks], legacy || mode === "metadata");
	} catch (error) {
		return result("error", error instanceof Error ? error.message : String(error));
	}
	const generated = buildLitNoteFrontmatter(item, settings);
	const changes: Record<string, unknown> = {
		citekey, zotero_item_key: item.itemkey, zotero_library_uri: item.libraryURI,
	};
	if (mode === "metadata") {
		for (const field of METADATA_FIELDS) changes[field] = generated[field];
		changes.aliases = buildAliases(item.title, fm.aliases);
	}
	const descriptions = Object.entries(changes)
		.filter(([key, next]) => value(fm[key]) !== value(next))
		.map(([key, next]) => `${key}: ${value(fm[key])} → ${value(next)}`);
	if (mode === "metadata" && value(fm.aliases) !== value(changes.aliases)) {
		descriptions.push("Links using an alias that is removed or changed may break.");
	}
	if (file.path !== target) descriptions.unshift(`Filename: ${file.path} → ${target}. ${backlinkWarning(app, file.path)}`);
	if (removedSelected.length) descriptions.push(`Remove ${removedSelected.length} attachment link(s) from the Obsidian note.`);
	if (identicalAttachments.length) {
		descriptions.push(`Use ${identicalAttachments.length} byte-identical Zotero attachment(s) without asking which copy to keep.`);
		const redundant = identicalAttachments.filter((pair) => pair.note.path !== pair.zotero.path);
		if (redundant.length) descriptions.push(`Keep the Zotero files and move identical copies to Trash after checking for shared references:\n${redundant.map((pair) => `- ${pair.note.path} → ${pair.zotero.path}`).join("\n")}`);
	}
	if (selectedAdditions.length) descriptions.push(`Add ${selectedAdditions.length} Zotero attachment link(s) to the Obsidian note.`);
	if (keptLinks.length) descriptions.push(`Keep ${keptLinks.length} unresolved attachment difference(s) in the Obsidian note.`);
	if (bodyEdits.length || headerEdits.length) descriptions.push(`Update ${bodyEdits.length + headerEdits.length} other attachment link(s) in the Obsidian note.`);
	if (oldHeader !== newHeader && !removedSelected.length && !selectedAdditions.length) descriptions.push("Update the note's managed attachment list.");
	if (!descriptions.length && !item.zoteroChanges) {
		return keptLinks.length
			? { ...result("error", `Attachment differences remain: ${keptLinks.join(", ")}.`), deferUntilChanged: true }
			: result("skipped");
	}

	const adoption = reassociating
		? `This Obsidian note records a different Zotero library. Confirm that it and "${item.title}" (Zotero item key ${item.itemkey}, ${item.libraryName || item.libraryURI}) describe the same work.`
		: legacy
		? `This Obsidian note does not record its Zotero library. Confirm that it and "${item.title}" (Zotero item key ${item.itemkey}, ${item.libraryName || item.libraryURI}) describe the same work.`
		: !oldHeader.includes(START)
			? "The info header has no managed attachment markers. Matching attachment links in it will become Zotero-managed."
			: "";
	if (legacy || mode === "metadata" || !oldHeader.includes(START) || file.path !== target || review.length || item.zoteroChanges) {
		const alreadyChanged = item.zoteroChanges
			? `Already changed in Zotero:\n- Item citekey: ${item.zoteroChanges.previousCitekey} → ${citekey}\n- ${item.zoteroChanges.attachmentMoves.length} verified attachment file move(s) or rename(s)${item.zoteroChanges.attachmentMoves.length ? " (shown in the attachment review)" : ""}.`
			: "";
		const message = [adoption, alreadyChanged, `Proposed Obsidian note changes:\n${descriptions.join("\n") || "None."}`, cancelNote.trim()].filter(Boolean).join("\n\n");
		const decision = await prompt("Update literature note", message, [
			{ label: "Apply Obsidian note changes", value: "create", cta: true },
			{ label: "Cancel", value: "cancel" },
		]);
		if (decision !== "create") return result("skipped");
	}
	if (!descriptions.length) return result("skipped");

	if (options.prepareOnly) {
		if (await app.vault.read(file) !== content) {
			return result("error", "The note changed while the decision was pending; retry.");
		}
		return { status: "prepared", citekey, snapshot: content, identicalAttachments, notePath: file.path };
	}
	if (identicalAttachments.some((pair) => pair.note.path !== pair.zotero.path) &&
		(!options.beforeApply || !options.trashIdenticalAttachments)) {
		return result("error", "Cannot verify duplicate attachments safely; no note changes were made.");
	}
	await options.beforeApply?.();
	try {
		if (oldHeader !== newHeader || bodyEdits.length) {
			await app.vault.process(file, (current) => {
				if (current !== content) throw new Error("The note changed while the update was pending; retry.");
				let updated = current;
				const edits = oldHeader === newHeader ? [...bodyEdits] : [
					...bodyEdits,
					{ start: headerStart, end: headerStart + oldHeader.length, original: oldHeader, replacement: newHeader },
				];
				for (const edit of edits.sort((a, b) => b.start - a.start)) {
					if (updated.slice(edit.start, edit.end) !== edit.original) throw new Error("An attachment link changed; retry.");
					updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
				}
				return updated;
			});
		}
		await app.fileManager.processFrontMatter(file, (current: Record<string, unknown>) => {
			for (const key of Object.keys(changes)) {
				if (value(current[key]) !== (originalValues[key] ?? value(undefined))) {
					throw new Error(`The note's ${key} changed while the update was pending; retry the update.`);
				}
			}
			for (const [key, next] of Object.entries(changes)) {
				if (next === undefined) delete current[key];
				else current[key] = next;
			}
		});
		if (file.path !== target) {
			await app.fileManager.renameFile(file, target);
			new Notice("Literature note renamed.", 5000);
		}
		if (identicalAttachments.length && options.trashIdenticalAttachments) {
			await options.trashIdenticalAttachments(identicalAttachments, file.path);
			const discarded = identicalAttachments.filter((pair) => pair.note.path !== pair.zotero.path);
			if (discarded.length) {
				new Notice(`Identical attachment copies moved to Trash; Zotero files kept:\n${discarded.map((pair) => `${pair.note.path} → ${pair.zotero.path}`).join("\n")}`, 15000);
			}
		}
		if (keptLinks.length) return {
			...result("error", `The note was updated, but attachment differences remain: ${keptLinks.join(", ")}. Review them before considering the attachments reconciled.`),
			deferUntilChanged: true,
		};
		return result("updated");
	} catch (error) {
		return result("error", `Update may be partial; retry after resolving: ${error instanceof Error ? error.message : String(error)}`);
	}
}
