import path from "path";
import { App, FileSystemAdapter, normalizePath, Notice, parseLinktext, TFile } from "obsidian";
import type { ReferenceCache } from "obsidian";
import { buildAliases, buildAttachmentLinks, buildLitNoteFrontmatter } from "./buildLitNote";
import type { AttachmentProblem } from "./buildLitNote";
import { findIdenticalAttachments } from "./attachmentIdentity";
import { attachmentLinkDestination } from "./attachmentLinks";
import type { IdenticalAttachment } from "./attachmentIdentity";
import { attachmentFingerprint, buildAttachmentMoveCandidate, buildAutomaticAttachmentMoveCandidate, preservedAttachmentMatches, validateTrashNoteFile, verifyAttachmentCopy, verifyAttachmentResourceArchive,
} from "./attachmentMove";
import type { NoteAttachmentLink } from "./attachmentMove";
import type { AttachmentMoveCandidate } from "./pendingReviews";
import type { AttachmentReviewRow, CitekeyConflictDetails, DecisionButton, NoteDecision,
} from "./decisionModal";
import { getLitNoteFiles } from "commons/litnote";
import { DUPLICATE_NOTES_REASON, matchingLitNotes } from "./duplicateNotes";
import { getMainWindow } from "commons/workspace";
import { setTimeoutIn } from "commons/windows";
import type { ZoteroItemPayload } from "./types";
import type { LitNoteWriterSettings } from "./writeLitNote";
import { litNotesFolderError } from "./writeLitNote";
import { METADATA_FIELDS } from "./metadataFields";

const START = "<!-- zotero-attachments:start -->";
const END = "<!-- zotero-attachments:end -->";
let warnedInvalidAttachmentBase = false;

export interface SyncResult {
	status:
		| "updated" | "skipped" | "missing" | "error" | "attachment-error" | "set-zotero-key" | "prepared" | "pending-review";
	citekey: string;
	error?: string;
	errorTitle?: string;
	dialogMessage?: string;
	noteCitekey?: string;
	expectedZoteroKey?: string;
	snapshot?: string;
	notePath?: string;
	identicalAttachments?: IdenticalAttachment[];
	deferUntilChanged?: boolean;
	identity?: CitekeyConflictDetails;
	attachmentProblems?: AttachmentProblem[];
	attachmentMove?: AttachmentMoveCandidate;
}

type Prompt = (title: string, message: string, buttons: DecisionButton[], review?: AttachmentReviewRow[], conflict?: CitekeyConflictDetails, bulkSummary?: string) => Promise<NoteDecision>;

const ATTACHMENT = /^(?:\[\[[^\]]+\|(?:PDF|HTM|DOC|PPT|EPUB|TXT)\]\]|\[(?:PDF|HTM|DOC|PPT|EPUB|TXT)\]\([^)]+\)|(?:PDF|HTM|DOC|PPT|EPUB|TXT|Attachment) unavailable in vault)$/;

function withoutBold(link: string): string {
	return link.startsWith("**") && link.endsWith("**") ? link.slice(2, -2) : link;
}

function isAttachment(link: string): boolean {
	return ATTACHMENT.test(withoutBold(link));
}

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
	const kept = segments.filter((segment, index) => index === 0 || !isAttachment(segment));
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
	return line.split(" | ").slice(1).filter(isAttachment);
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
	const match = withoutBold(link).match(/^(?:\[\[([^|\]]+)(?:\|[^\]]*)?\]\]|\[[^\]]+\]\(([^)]+)\))$/);
	return match?.[1] ?? (match?.[2] ? decodeURIComponent(match[2]) : undefined);
}

function relativeVaultAttachmentLinks(app: App, line: string): string {
	if (!(app.vault.adapter instanceof FileSystemAdapter)) return line;
	const root = app.vault.adapter.getBasePath();
	for (const link of existingAttachmentLinks(line)) {
		const target = attachmentLinkPath(link);
		if (!target) continue;
		const parsed = parseLinktext(target);
		if (!path.isAbsolute(parsed.path)) continue;
		const relative = path.relative(root, parsed.path);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		const vaultPath = relative.split(path.sep).join("/");
		if (!(app.vault.getAbstractFileByPath(vaultPath) instanceof TFile)) continue;
		const replacement = vaultPath + (parsed.subpath ?? "");
		const raw = withoutBold(link);
		const normalized = raw.startsWith("[[")
			? link.replace(target, replacement)
			: link.replace(`(${encodeURI(target)})`, `(${encodeURI(replacement)})`).replace(`(${target})`, `(${replacement})`);
		line = line.replace(link, normalized);
	}
	return line;
}

async function retainLiveNoteLinks(app: App, notePath: string, previous: string[], incoming: string[]): Promise<string[]> {
	const retained: string[] = [];
	for (const link of previous) {
		const target = attachmentLinkPath(link);
		const resolved = target ? attachmentLinkDestination(app, target, notePath) : null;
		const info = resolved instanceof TFile ? await app.vault.adapter.stat(resolved.path) : null;
		if (!info || info.type !== "file" || info.size === 0) {
			const ext = linkExtension(link);
			const alternatives = incoming.filter((candidate) => ext && linkExtension(candidate) === ext);
			if (alternatives.length === 1) continue;
		}
		retained.push(link);
	}
	return retained;
}

const LABEL_EXTENSIONS: Record<string, string> = {
	PDF: ".pdf", HTM: ".html", DOC: ".docx", PPT: ".pptx", EPUB: ".epub", TXT: ".txt",
};

/** The file type a header attachment link stands for, from its label or placeholder text. */
function linkExtension(link: string): string | undefined {
	const label = withoutBold(link).match(/^(?:\[\[[^\]]+\|(\w+)\]\]|\[(\w+)\]\(|(\w+) unavailable in vault$)/);
	return LABEL_EXTENSIONS[label?.[1] ?? label?.[2] ?? label?.[3] ?? ""];
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
	return (
		!!key && key !== "." && key !== ".." &&
		!/[/\\<>:"|?*]/.test(key) &&
		!Array.from(key).some((char) => char.charCodeAt(0) < 32) &&
		!/[. ]$/.test(key) &&
		!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(key)
	);
}

function isStringArray(input: unknown): input is string[] {
	return Array.isArray(input) && input.every((entry: unknown) => typeof entry === "string");
}

function sameStringMembership(left: unknown, right: unknown): boolean {
	const list = (input: unknown): string[] | undefined =>
		input === undefined ? [] : isStringArray(input) ? input : undefined;
	const a = list(left);
	const b = list(right);
	if (!a || !b) return false;
	const leftSet = new Set(a);
	const rightSet = new Set(b);
	return leftSet.size === rightSet.size && [...leftSet].every((entry) => rightSet.has(entry));
}

export async function syncLitNote(
	app: App,
	settings: LitNoteWriterSettings,
	item: ZoteroItemPayload,
	mode: "auto" | "metadata",
	prompt: Prompt,
	options: {
		prepareOnly?: boolean;
		reconcileCollections?: boolean;
		expectedContent?: string;
		expectedIdenticalAttachments?: IdenticalAttachment[];
		beforeApply?: () => Promise<void> | void;
		trashIdenticalAttachments?: (
			pairs: IdenticalAttachment[],
			notePath: string
		) => Promise<void>;
	} = {}
): Promise<SyncResult> {
	const citekey = item.citekey?.trim() ?? "";
	let identity: CitekeyConflictDetails | undefined;
	const result = (status: SyncResult["status"], error?: string): SyncResult => ({
		status,
		citekey,
		...(error ? { error } : {}),
		...(status === "error" && identity ? { identity } : {}),
	});
	const failure = (errorTitle: string, error: string, dialogMessage?: string): SyncResult => ({
		...result("error", error),
		errorTitle,
		...(dialogMessage ? { dialogMessage } : {}),
	});
	const folderError = litNotesFolderError(settings.litNotesFolder);
	if (folderError) return failure("Literature notes folder is invalid", folderError);
	if (!validKey(citekey) || !item.itemkey || !item.libraryURI) {
		return failure(
			"Zotero item identity is incomplete or invalid",
			"A valid citation key, Zotero item key, and library identity are required. Check the item in Zotero, then retry."
		);
	}

	const matchingKey = getLitNoteFiles(app, settings.litNotesFolder).filter((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && fm.zotero_item_key === item.itemkey;
	});
	let candidates = matchingLitNotes(
		app,
		settings.litNotesFolder,
		item as { itemkey: string; libraryURI: string }
	);
	let reassociating = false;
	if (!candidates.length && mode === "metadata" && matchingKey.length === 1) {
		candidates = matchingKey;
		reassociating = true;
	}
	if (!candidates.length && mode === "metadata" && matchingKey.length > 1) {
		return failure(
			"Multiple notes have this Zotero item key",
			`More than one literature note has this Zotero item key:\n${matchingKey.map((note) => `- ${note.path}`).join("\n")}\n\nCheck the notes' Zotero identities before retrying. No association was changed.`
		);
	}
	if (!candidates.length) return result("missing");
	if (candidates.length !== 1) {
		identity = {
			title: item.title,
			itemkey: item.itemkey,
			libraryURI: item.libraryURI,
			zoteroCitekey: citekey,
			notePaths: candidates.map((note) => note.path),
			noteOpenFollowUp:
				"After you correct the notes, Saver rechecks this item's Zotero review automatically.",
		};
		return failure(
			DUPLICATE_NOTES_REASON,
			"More than one literature note matches this Zotero item.",
			"These notes contain the same Zotero item key. Saver cannot choose between them.\n\nOpen the notes side by side and correct their Zotero identities manually. Keep zotero_item_key and zotero_library_uri on the intended literature note; remove those duplicate properties from the other notes if they should no longer be linked to this item.\n\nNo notes or attachments were changed. When only one note matches, Saver rechecks this item's Zotero review automatically."
		);
	}
	const file = candidates[0];
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const noteKey = typeof fm?.citekey === "string" ? fm.citekey.trim() : "";
	const preservedAttachmentKeys = new Set<string>();
	const preservedCopies: unknown[] =
		fm?.zotero_item_key === item.itemkey &&
		fm?.zotero_library_uri === item.libraryURI &&
		Array.isArray(fm.zotero_attachment_preserved_copies)
			? fm.zotero_attachment_preserved_copies
			: [];
	for (const copy of preservedCopies) {
		if (!copy || typeof copy !== "object") continue;
		const { sourceKey, linkedKey, sourcePath, destinationPath, sha256 } = copy as Record<
			string,
			unknown
		>;
		if (
			typeof sourceKey !== "string" ||
			typeof linkedKey !== "string" ||
			typeof sourcePath !== "string" ||
			typeof destinationPath !== "string" ||
			typeof sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(sha256) ||
			!path.isAbsolute(sourcePath) ||
			!path.isAbsolute(destinationPath)
		)
			continue;
		const source = item.attachments?.find((attachment) => attachment.itemkey === sourceKey);
		const linked = item.attachments?.find((attachment) => attachment.itemkey === linkedKey);
		const samePath = (a: string | undefined, b: string): boolean => {
			if (!a || !path.isAbsolute(a)) return false;
			const first = path.resolve(a);
			const second = path.resolve(b);
			return process.platform === "win32"
				? first.toLowerCase() === second.toLowerCase()
				: first === second;
		};
		if (
			linked?.mode === "linked" &&
			samePath(source?.path, sourcePath) &&
			samePath(linked.path, destinationPath) &&
			(await preservedAttachmentMatches(sourcePath, destinationPath, true, sha256))
		)
			preservedAttachmentKeys.add(sourceKey);
	}
	const attachmentItem = preservedAttachmentKeys.size
		? {
				...item,
				attachments: item.attachments?.filter(
					(attachment) => !preservedAttachmentKeys.has(attachment.itemkey ?? "")
				),
			}
		: item;
	identity = {
		title: item.title,
		itemkey: item.itemkey,
		libraryURI: item.libraryURI,
		notePath: file.path,
		noteCitekey: noteKey || "(not set)",
		zoteroCitekey: citekey,
	};
	if (!fm)
		return failure(
			"Note frontmatter is not indexed",
			"The note's frontmatter is not indexed yet. Wait for Obsidian to finish indexing, then retry.",
			"Wait for Obsidian to finish indexing, then retry."
		);
	const originalValues = Object.fromEntries(
		Object.entries(fm).map(([key, current]) => [key, value(current)])
	);
	const legacy = !fm.zotero_library_uri;
	const folder = file.parent?.path ?? "";
	const target = normalizePath(folder ? `${folder}/${citekey}.md` : `${citekey}.md`);
	const content = await app.vault.read(file);
	if (options.expectedContent !== undefined && content !== options.expectedContent) {
		return failure(
			"Note changed during update",
			"The note changed while the update was pending; retry.",
			"Retry the update."
		);
	}
	const oldHeader = header(content);
	if (!oldHeader)
		return failure(
			"Zotero info callout is missing",
			"The note has no Zotero info callout; attachment links were not changed. Restore the info callout or update the note manually.",
			"Restore the info callout or update the note manually. Attachment links were not changed."
		);
	const generated = buildLitNoteFrontmatter(item, settings);
	const missingZoteroTags = fm.zotero_tags === undefined;
	const missingZoteroCollections = fm.zotero_collections === undefined;
	const missingZoteroLists = missingZoteroTags || missingZoteroCollections;
	const applyCollections =
		item.collections !== undefined &&
		(mode === "metadata" || (mode === "auto" && options.reconcileCollections));
	const collectionChanged =
		applyCollections && !sameStringMembership(fm.zotero_collections, generated.zotero_collections);
	const writeManagedLists = () =>
		app.fileManager.processFrontMatter(file, (current: Record<string, unknown>) => {
			for (const key of ["zotero_item_key", "zotero_library_uri", "zotero_tags", "zotero_collections"]) {
				if (value(current[key]) !== (originalValues[key] ?? value(undefined))) {
					throw new Error("The note's " + key + " changed; retry.");
				}
			}
			if (collectionChanged) current.zotero_collections = generated.zotero_collections ?? [];
			if (missingZoteroTags) current.zotero_tags = generated.zotero_tags ?? [];
			if (missingZoteroCollections) {
				current.zotero_collections =
					item.collections === undefined ? [] : generated.zotero_collections ?? [];
			}
		});
	const filenameMatchesZotero = file.path === target && !legacy && !reassociating;
	if (
		noteKey &&
		noteKey !== citekey &&
		filenameMatchesZotero &&
		mode === "auto" &&
		!item.zoteroChanges &&
		!collectionChanged &&
		!missingZoteroLists
	) {
		if (options.prepareOnly) {
			return {
				status: "prepared",
				citekey,
				snapshot: content,
				notePath: file.path,
				identicalAttachments: [],
			};
		}
		await options.beforeApply?.();
		try {
			if ((await app.vault.read(file)) !== content)
				throw new Error("The note changed while the update was pending; retry.");
			await app.fileManager.processFrontMatter(file, (current: Record<string, unknown>) => {
				for (const key of ["citekey", "zotero_item_key", "zotero_library_uri"]) {
					if (value(current[key]) !== (originalValues[key] ?? value(undefined))) {
						throw new Error(
							`The note's ${key} changed while the update was pending; retry.`
						);
					}
				}
				current.citekey = citekey;
			});
			return result("updated");
		} catch (error) {
			return failure(
				"Citation key could not be updated",
				error instanceof Error ? error.message : String(error)
			);
		}
	}
	if (noteKey && noteKey !== citekey && !filenameMatchesZotero) {
		const check = item.citationKeyCheck;
		// Background rechecks omit Zotero's key check; queue the decision itself instead of an error.
		if (!check)
			return failure(
				"Citekeys differ",
				`The note uses citation key ${noteKey}; Zotero uses ${citekey}. Open this review to choose which key to keep.`,
				`The note uses ${noteKey}; Zotero uses ${citekey}. Open this review to choose which key to keep.`
			);
		if (
			check.citekey !== noteKey ||
			!Array.isArray(check.matches) ||
			check.matches.some(
				(match) =>
					!match ||
					typeof match.title !== "string" ||
					typeof match.citekey !== "string" ||
					typeof match.libraryURI !== "string" ||
					typeof match.itemkey !== "string"
			)
		) {
			return failure(
				"Obsidian citation key could not be checked in Zotero",
				"Could not verify whether the Obsidian citation key is already used in Zotero. Retry the update.",
				"Retry the update to check whether the key is already used."
			);
		}
		const association = reassociating
			? `\n\nThe note records a different Zotero library. Confirm both describe the same work.`
			: legacy
				? `\n\nThe note doesn't record its Zotero library. Confirm it matches the item in ${item.libraryName || item.libraryURI}.`
				: "";
		const duplicates = check.matches.length
			? `\n\n${check.matches.length === 1 ? "Another Zotero item uses" : "Other Zotero items use"} the same or a similar citation key:\n${check.matches
					.slice(0, 3)
					.map(
						(match) =>
							`- ${match.title} (${match.citekey}; ${match.libraryURI === item.libraryURI ? "same library" : "another library"})`
					)
					.join(
						"\n"
					)}${check.matches.length > 3 ? `\n- And ${check.matches.length - 3} more` : ""}\nUsing it may make citations ambiguous.`
			: "";
		const buttons: DecisionButton[] = [
			...(validKey(noteKey)
				? [{ label: "Use Obsidian citekey", value: "use-obsidian" as const }]
				: []),
			{ label: "Use Zotero citekey", value: "use-zotero", cta: true },
			{ label: "Cancel", value: "cancel" },
		];
		const choice = await prompt(
			"Citekeys differ",
			`Choose which citation key to keep.\n\nUse Zotero: review changes to the note and its links.${validKey(noteKey) ? "\nUse Obsidian: Zotero changes now and may rename files; canceling later will not undo those changes." : ""}${association}${duplicates}`,
			buttons,
			undefined,
			identity
		);
		if (choice === "use-obsidian") {
			const noteTarget = normalizePath(folder ? `${folder}/${noteKey}.md` : `${noteKey}.md`);
			const noteCollision = app.vault.getAbstractFileByPath(noteTarget);
			if (noteCollision && noteCollision !== file)
				return failure(
					"Note filename already exists",
					`Cannot rename note: ${noteTarget} already exists. Zotero was not changed. Check the existing note and resolve the filename conflict before retrying.`,
					`${noteTarget}\n\nResolve the filename conflict, then retry. Zotero was not changed.`
				);
			if (reassociating) {
				const confirmed = await prompt(
					"Confirm Zotero item",
					`This Obsidian note records a different Zotero library. Confirm that it and "${item.title}" (Zotero item key ${item.itemkey}, ${item.libraryName || item.libraryURI}) describe the same work before changing Zotero.`,
					[
						{ label: "Continue", value: "create" },
						{ label: "Cancel", value: "cancel" },
					],
					undefined,
					identity
				);
				if (confirmed !== "create") return result("skipped");
			}
			if ((await app.vault.read(file)) !== content) {
				return failure(
					"Note changed during decision",
					"The note changed while the decision was pending; retry.",
					"Retry the update."
				);
			}
			return {
				status: "set-zotero-key",
				citekey,
				noteCitekey: noteKey,
				expectedZoteroKey: citekey,
				snapshot: content,
			};
		}
		if (choice !== "use-zotero") return result("skipped");
	}
	const collision = app.vault.getAbstractFileByPath(target);
	if (collision && collision !== file)
		return failure(
			"Note filename already exists",
			`Cannot rename note: ${target} already exists. Check the existing note and resolve the filename conflict before retrying.`,
			`${target}\n\nResolve the filename conflict, then retry.`
		);
	const automaticAttachments =
		item.automaticAttachments &&
		mode === "auto" &&
		!legacy &&
		!reassociating &&
		!item.zoteroChanges &&
		noteKey === citekey &&
		file.path === target;
	const automaticAttachmentError = (message: string): SyncResult => {
		console.error("Automatic Zotero attachment reconciliation failed", message);
		return result("attachment-error", message);
	};
	if (automaticAttachments) {
		if (!(app.vault.adapter instanceof FileSystemAdapter)) {
			return automaticAttachmentError(
				"The vault path is unavailable; attachment reconciliation was skipped."
			);
		}
		const vaultRoot = app.vault.adapter.getBasePath();
		const base = item.linkedAttachmentBaseDirectory;
		const relative = base && path.isAbsolute(base) ? path.relative(vaultRoot, base) : undefined;
		if (
			!item.linkedAttachmentBaseDirectoryValidated ||
			relative === undefined ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			const message =
				"Zotero's Linked Attachment Base Directory is not valid inside the vault. Attachment reconciliation was skipped.";
			if (!warnedInvalidAttachmentBase) {
				new Notice(message, 0);
				warnedInvalidAttachmentBase = true;
			}
			return result("attachment-error", message);
		}
		warnedInvalidAttachmentBase = false;
		try {
			const links = existingAttachmentLinks(relativeVaultAttachmentLinks(app, oldHeader)).map(
				(link): NoteAttachmentLink => {
					const linkpath = attachmentLinkPath(link);
					const resolved = linkpath
						? attachmentLinkDestination(app, linkpath, file.path)
						: null;
					return {
						...(linkpath ? { target: parseLinktext(linkpath).path } : {}),
						...(resolved ? { absolutePath: path.join(vaultRoot, resolved.path) } : {}),
						...(linkExtension(link) ? { extension: linkExtension(link) } : {}),
					};
				}
			);
			const attachmentMove = await buildAutomaticAttachmentMoveCandidate(
				item,
				links,
				vaultRoot
			);
			if (attachmentMove)
				return {
					...failure(
						"Automatic attachment reconciliation",
						"Zotero attachments need to be linked to vault files."
					),
					snapshot: content,
					notePath: file.path,
					attachmentMove,
				};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return automaticAttachmentError(message);
		}
	}
	let unavailable: AttachmentProblem[] = [];
	const attachmentLinks = await buildAttachmentLinks(app, attachmentItem, target, (details) => {
		unavailable = details;
	});
	if (unavailable.length) {
		if (automaticAttachments)
			return automaticAttachmentError(
				unavailable
					.map(
						(entry) => `${entry.path ?? entry.label}: ${entry.problem} ${entry.action}`
					)
					.join("\n")
			);
		let attachmentMove: AttachmentMoveCandidate | undefined;
		if (
			mode === "auto" &&
			!item.zoteroChanges &&
			fm?.zotero_item_key === item.itemkey &&
			fm.zotero_library_uri === item.libraryURI &&
			fm.citekey === citekey &&
			file.path === target &&
			app.vault.adapter instanceof FileSystemAdapter
		) {
			try {
				const vaultRoot = app.vault.adapter.getBasePath();
				const links = existingAttachmentLinks(oldHeader).map((link): NoteAttachmentLink => {
					const linkpath = attachmentLinkPath(link);
					const resolved = linkpath
						? attachmentLinkDestination(app, linkpath, file.path)
						: null;
					return {
						...(linkpath ? { target: parseLinktext(linkpath).path } : {}),
						...(resolved ? { absolutePath: path.join(vaultRoot, resolved.path) } : {}),
						...(linkExtension(link) ? { extension: linkExtension(link) } : {}),
					};
				});
				attachmentMove = await buildAttachmentMoveCandidate(
					attachmentItem,
					noteKey,
					links,
					unavailable,
					vaultRoot
				);
			} catch (error) {
				console.warn(
					"Could not check whether Zotero attachments can be moved safely",
					error
				);
			}
		}
		return {
			...failure(
				unavailable.every((entry) => entry.title === unavailable[0].title)
					? unavailable[0].title
					: "Zotero attachments need attention",
				`${unavailable.map((entry) => `Zotero attachment: ${entry.path ?? entry.label}\n${entry.problem} ${entry.action}`).join("\n\n")}\n\nExisting note links were preserved.`
			),
			attachmentProblems: unavailable,
			...(attachmentMove ? { attachmentMove } : {}),
		};
	}
	let oldLinks: string[];
	let relativeHeader: string;
	try {
		relativeHeader = relativeVaultAttachmentLinks(app, oldHeader);
		oldLinks = existingAttachmentLinks(relativeHeader);
	} catch (error) {
		if (automaticAttachments)
			return automaticAttachmentError(error instanceof Error ? error.message : String(error));
		return failure(
			"Managed attachment markers are invalid",
			error instanceof Error ? error.message : String(error),
			"Check the note's managed attachment markers, then retry. Attachment links were not changed."
		);
	}
	const resolveAttachment = (link: string, sourcePath: string): TFile | null => {
		const linkPath = attachmentLinkPath(link);
		const candidate = linkPath ? attachmentLinkDestination(app, linkPath, sourcePath) : null;
		return candidate instanceof TFile ? candidate : null;
	};
	const zoteroOnlyLinks = [...attachmentLinks];
	const noteOnlyLinks = oldLinks.filter((link) => {
		const resolved = !legacy ? resolveAttachment(link, file.path) : null;
		const index = zoteroOnlyLinks.findIndex(
			(other) =>
				other === link ||
				(resolved && resolveAttachment(other, target)?.path === resolved.path)
		);
		if (index < 0) return true;
		zoteroOnlyLinks.splice(index, 1);
		return false;
	});
	const repairedLinks: Array<{ note: string; zotero: string }> = [];
	// A rename or Zotero citation-key change is confirmed in the same prompt, so the repair joins that plan.
	if (mode === "auto" && !legacy && !reassociating && noteKey === citekey) {
		try {
			for (const link of noteOnlyLinks) {
				const ext = linkExtension(link);
				if (
					!ext ||
					noteOnlyLinks.filter((other) => linkExtension(other) === ext).length !== 1
				)
					continue;
				const candidates = zoteroOnlyLinks.filter((other) => linkExtension(other) === ext);
				if (candidates.length !== 1) continue;
				const noteFile = resolveAttachment(link, file.path);
				const zoteroFile = resolveAttachment(candidates[0], target);
				if (!zoteroFile) continue;
				const [noteStat, zoteroStat] = await Promise.all([
					noteFile ? app.vault.adapter.stat(noteFile.path) : Promise.resolve(null),
					app.vault.adapter.stat(zoteroFile.path),
				]);
				if (
					(!noteFile || (noteStat?.type === "file" && noteStat.size === 0)) &&
					zoteroStat?.type === "file" &&
					zoteroStat.size > 0
				) {
					repairedLinks.push({ note: link, zotero: candidates[0] });
				}
			}
		} catch (error) {
			if (automaticAttachments)
				return automaticAttachmentError(
					error instanceof Error ? error.message : String(error)
				);
			return failure(
				"Attachment files could not be checked",
				`Could not check attachment files: ${error instanceof Error ? error.message : String(error)}. Check the files and their permissions, then retry.`
			);
		}
	}
	const unmatchedNoteLinks = subtractLinks(
		noteOnlyLinks,
		repairedLinks.map((entry) => entry.note)
	);
	const unmatchedZoteroLinks = subtractLinks(
		zoteroOnlyLinks,
		repairedLinks.map((entry) => entry.zotero)
	);
	if (automaticAttachments) {
		let updatedHeader = oldHeader;
		try {
			const links = [
				...(await retainLiveNoteLinks(
					app,
					file.path,
					subtractLinks(
						oldLinks,
						repairedLinks.map((entry) => entry.note)
					),
					unmatchedZoteroLinks
				)),
				...unmatchedZoteroLinks,
				...repairedLinks.map((entry) => entry.zotero),
			];
			updatedHeader =
				unmatchedZoteroLinks.length || repairedLinks.length
					? managedHeader(relativeHeader, links, true)
					: relativeHeader;
			if (updatedHeader === oldHeader && !collectionChanged && !missingZoteroLists) return result("skipped");
			if (options.prepareOnly)
				return {
					status: "prepared",
					citekey,
					snapshot: content,
					notePath: file.path,
					identicalAttachments: [],
				};
			await options.beforeApply?.();
			if (updatedHeader !== oldHeader) {
				await app.vault.process(file, (current) => {
					if (current !== content)
						throw new Error("The note changed while the update was pending; retry.");
					return current.replace(oldHeader, updatedHeader);
				});
			} else if ((await app.vault.read(file)) !== content) {
				throw new Error("The note changed while the update was pending; retry.");
			}
		} catch (error) {
			return automaticAttachmentError(error instanceof Error ? error.message : String(error));
		}
		if (collectionChanged || missingZoteroLists) {
			try {
				await writeManagedLists();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return failure(
					"Zotero list properties could not be updated",
					updatedHeader !== oldHeader
						? "Attachment links were updated, but the Zotero list properties were not: " + message
						: message
				);
			}
		}
		return result("updated");
	}
	const noteOnlyFiles = [
		...new Map(
			unmatchedNoteLinks.flatMap((link) => {
				const candidate = resolveAttachment(link, file.path);
				return candidate ? [[candidate.path, candidate] as const] : [];
			})
		).values(),
	];
	const noteOnlyPaths = new Set(noteOnlyFiles.map((candidate) => candidate.path));
	const noteOnlyLinkPaths = new Set(
		unmatchedNoteLinks.flatMap((link) => {
			const linkPath = attachmentLinkPath(link);
			return linkPath ? [parseLinktext(linkPath).path] : [];
		})
	);
	const zoteroFiles = [
		...new Map(
			attachmentLinks.flatMap((link) => {
				const candidate = resolveAttachment(link, target);
				return candidate ? [[candidate.path, candidate] as const] : [];
			})
		).values(),
	];
	let identicalAttachments: IdenticalAttachment[];
	try {
		identicalAttachments =
			noteOnlyFiles.length && zoteroFiles.length
				? await findIdenticalAttachments(app, noteOnlyFiles, zoteroFiles)
				: [];
	} catch (error) {
		return failure(
			"Attachment files could not be compared",
			`Could not compare attachment files: ${error instanceof Error ? error.message : String(error)}. Check the files and their permissions, then retry.`,
			`${error instanceof Error ? error.message : String(error)}. Check the files and their permissions, then retry.`
		);
	}
	if (
		options.expectedIdenticalAttachments &&
		JSON.stringify(identicalAttachments) !==
			JSON.stringify(options.expectedIdenticalAttachments)
	) {
		return failure(
			"Attachment files changed during update",
			"Attachment files changed while the update was pending; retry.",
			"Retry the update."
		);
	}
	const identicalNotePaths = new Set(identicalAttachments.map((pair) => pair.note.path));
	const identicalZoteroPaths = new Set(identicalAttachments.map((pair) => pair.zotero.path));
	const automaticRemoved = unmatchedNoteLinks.filter((link) => {
		const candidate = resolveAttachment(link, file.path);
		return candidate && identicalNotePaths.has(candidate.path);
	});
	const removedLinks = subtractLinks(unmatchedNoteLinks, automaticRemoved);
	const addedLinks = unmatchedZoteroLinks.filter((link) => {
		const candidate = resolveAttachment(link, target);
		return !candidate || !identicalZoteroPaths.has(candidate.path);
	});
	const keptLinks: string[] = [];
	const keptManagedLinks: string[] = [];
	const cached = app.metadataCache.getFileCache(file);
	const references: ReferenceCache[] = [...(cached?.links ?? []), ...(cached?.embeds ?? [])];
	const headerLine = content.split(/\r?\n/).findIndex((line) => line === oldHeader);
	const headerStart = content
		.split(/\r?\n/)
		.slice(0, headerLine)
		.reduce(
			(offset, line) =>
				offset +
				line.length +
				(content.slice(offset + line.length, offset + line.length + 2) === "\r\n" ? 2 : 1),
			0
		);
	const managedRanges: Array<{ start: number; end: number }> = [];
	const markerStart = oldHeader.indexOf(START);
	const markerEnd = oldHeader.indexOf(END);
	if (markerStart >= 0 && markerEnd >= markerStart) {
		managedRanges.push({
			start: headerStart + markerStart,
			end: headerStart + markerEnd + END.length,
		});
	} else {
		let offset = headerStart;
		for (const segment of oldHeader.split(" | ")) {
			if (isAttachment(segment))
				managedRanges.push({ start: offset, end: offset + segment.length });
			offset += segment.length + 3;
		}
	}
	const outsideAttachments = references.filter((reference) => {
		const path = parseLinktext(reference.link).path;
		const handled =
			reference.position.start.line === headerLine &&
			managedRanges.some(
				(range) =>
					reference.position.start.offset >= range.start &&
					reference.position.end.offset <= range.end
			);
		return (
			!handled && !/^https?:/i.test(path) && /\.(?:pdf|html|docx|pptx|epub|txt)$/i.test(path)
		);
	});
	const attachmentFiles = outsideAttachments.length ? zoteroFiles : [];
	const bodyEdits: Array<{ start: number; end: number; original: string; replacement: string }> =
		[];
	const headerEdits: typeof bodyEdits = [];
	const bodyChoices: Array<{
		reference: ReferenceCache;
		eligible: TFile[];
		existing: TFile | null;
	}> = [];
	for (const reference of outsideAttachments) {
		const { path } = parseLinktext(reference.link);
		const existing = attachmentLinkDestination(app, path, file.path);
		if (existing && attachmentFiles.some((candidate) => candidate.path === existing.path))
			continue;
		if (existing ? !noteOnlyPaths.has(existing.path) : !noteOnlyLinkPaths.has(path)) continue;
		const identical =
			existing && identicalAttachments.find((pair) => pair.note.path === existing.path);
		const survivor =
			identical && zoteroFiles.find((candidate) => candidate.path === identical.zotero.path);
		if (survivor) {
			const start = reference.position.start.offset;
			const end = reference.position.end.offset;
			if (content.slice(start, end) !== reference.original) {
				return failure(
					"Obsidian link index is out of date",
					"Obsidian's link index is out of date; retry after the note is indexed.",
					"Wait for the note to be indexed, then retry."
				);
			}
			const { subpath } = parseLinktext(reference.link);
			const replacement = app.fileManager.generateMarkdownLink(
				survivor,
				target,
				subpath,
				reference.displayText
			);
			const edit = {
				start,
				end,
				original: reference.original,
				replacement: reference.original.startsWith("!") ? `!${replacement}` : replacement,
			};
			(reference.position.start.line === headerLine ? headerEdits : bodyEdits).push(edit);
			continue;
		}
		const eligible = attachmentFiles.filter(
			(candidate) =>
				candidate.extension.toLowerCase() === path.split(".").pop()?.toLowerCase()
		);
		bodyChoices.push({ reference, eligible, existing });
	}
	const selectedAdditions: string[] = [];
	const removedSelected: string[] = [
		...automaticRemoved,
		...repairedLinks.map((entry) => entry.note),
	];
	const reviewFile = (
		link: string,
		sourcePath: string,
		role: string
	): Array<{ path: string; modified?: number; role: string }> => {
		const path = attachmentLinkPath(link);
		const candidate = path ? attachmentLinkDestination(app, path, sourcePath) : null;
		return candidate instanceof TFile
			? [{ path: candidate.path, modified: candidate.stat?.mtime, role }]
			: [];
	};
	const review: AttachmentReviewRow[] = [
		...removedLinks.map((link): AttachmentReviewRow => {
			const linkPath = attachmentLinkPath(link);
			const resolved = resolveAttachment(link, file.path);
			const filename = linkPath ? parseLinktext(linkPath).path.split("/").pop() : undefined;
			const sameName =
				filename &&
				zoteroFiles.some((candidate) => candidate.path.split("/").pop() === filename);
			const description = !resolved
				? sameName
					? "A Zotero item attachment has the same filename, but the Obsidian note link could not be resolved. Saver cannot determine whether they refer to the same file."
					: "Obsidian could not resolve this link to a file in the vault, so Saver cannot compare the files."
				: zoteroFiles.length
					? sameName
						? "A Zotero item attachment has the same filename, but the file contents differ."
						: "The file contents differ from the available Zotero item attachments."
					: undefined;
			return {
				kind: "note",
				label: `Obsidian note link target: ${linkPath ?? "unavailable attachment"}`,
				copyValue: linkPath,
				description,
				options: [
					{ label: "Keep this link in the Obsidian note", value: "keep" },
					{ label: "Remove this link from the Obsidian note", value: "remove" },
				],
				defaultValue: "keep",
				files: reviewFile(link, file.path, "Obsidian note attachment"),
			};
		}),
		...addedLinks.map((link): AttachmentReviewRow => ({
			kind: "add",
			label: `Zotero item attachment: ${attachmentLinkPath(link) ?? "unavailable attachment"}`,
			description:
				"No matching resolved attachment link was identified in the Obsidian note's info header.",
			copyValue: attachmentLinkPath(link),
			options: [
				{ label: "Add a link to the Obsidian note", value: "add" },
				{ label: "Do not add a link", value: "skip" },
			],
			defaultValue: "add",
			files: reviewFile(link, target, "Zotero item attachment"),
		})),
		...bodyChoices.map(({ reference, eligible, existing }): AttachmentReviewRow => ({
			kind: "body",
			label: `Another Obsidian note link: ${parseLinktext(reference.link).path}`,
			copyValue: reference.link,
			options: [
				{ label: "Keep this Obsidian note link unchanged", value: "keep" },
				...eligible.map((candidate, index) => ({
					label: `Change this Obsidian note link to ${candidate.path}`,
					value: String(index),
				})),
			],
			defaultValue: "keep",
			files: [
				...(existing instanceof TFile
					? [
							{
								path: existing.path,
								modified: existing.stat?.mtime,
								role: "Current Obsidian note link",
							},
						]
					: []),
				...eligible.map((candidate) => ({
					path: candidate.path,
					modified: candidate.stat?.mtime,
					role: "Zotero item attachment",
				})),
			],
		})),
		...(item.zoteroChanges?.attachmentMoves ?? []).map((move): AttachmentReviewRow => ({
			kind: "zotero",
			label: `Changed with your Zotero citation key (attachment item key ${move.itemkey}): ${move.from} → ${move.to}`,
			options: [{ label: "Changed in Zotero", value: "changed" }],
			defaultValue: "changed",
		})),
	];
	const cancelNote = item.zoteroChanges
		? `Cancel stops this Obsidian update; it does not undo your Zotero citation-key change${item.zoteroChanges.attachmentMoves.length ? " or attachment moves" : ""}.`
		: "";
	if (review.length) {
		let selections: unknown;
		{
			const zoteroChanges = item.zoteroChanges
				? `The citation-key change you just made in Zotero was ${item.zoteroChanges.previousCitekey} → ${citekey}.${item.zoteroChanges.attachmentMoves.length ? ` Zotero also moved or renamed ${item.zoteroChanges.attachmentMoves.length} verified attachment file(s).` : ""}`
				: "";
			const differences = removedLinks.length || addedLinks.length || bodyChoices.length;
			const duplicateNotice = identicalAttachments.some(
				(pair) => pair.note.path !== pair.zotero.path
			)
				? "Identical duplicate files may be moved to Trash after the next confirmation."
				: "";
			const diagnosis = [
				removedLinks.length
					? `${removedLinks.length} note attachment link(s) could not be matched to Zotero attachments.`
					: "",
				addedLinks.length
					? `${addedLinks.length} Zotero attachment(s) are not linked in the note.`
					: "",
				bodyChoices.length
					? `${bodyChoices.length} other note link(s) may need a different target.`
					: "",
			]
				.filter(Boolean)
				.join(" ");
			const choice = await prompt(
				differences ? "Attachment links differ" : "Zotero attachments changed",
				[
					diagnosis,
					differences
						? "Choose which links to keep, remove, add, or change below."
						: "Review the Zotero changes below.",
					zoteroChanges,
					duplicateNotice,
					cancelNote,
				]
					.filter(Boolean)
					.join("\n\n"),
				[
					{ label: "Continue", value: "create", cta: true },
					{ label: "Cancel", value: "cancel" },
				],
				review,
				identity
			);
			if (choice === "cancel") return result("skipped");
			if (!choice.startsWith("review:"))
				return failure(
					"Attachment review was not completed",
					"The attachment review was not completed; no note changes were made.",
					"Review the attachments again. No note changes were made."
				);
			try {
				selections = JSON.parse(choice.slice("review:".length));
			} catch {
				return failure(
					"Attachment review is invalid",
					"The attachment review was invalid; no note changes were made.",
					"Review the attachments again. No note changes were made."
				);
			}
		}
		if (
			!isStringArray(selections) ||
			selections.length !== review.length ||
			selections.some(
				(selection, index) =>
					!review[index].options.some((option) => option.value === selection)
			)
		) {
			return failure(
				"Attachment review changed",
				"The attachment review changed; no note changes were made.",
				"Review the attachments again. No note changes were made."
			);
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
			if (!selected)
				return failure(
					"Selected attachment is no longer available",
					"The selected attachment is no longer available; retry.",
					"Review the attachments again."
				);
			const { subpath } = parseLinktext(reference.link);
			const start = reference.position.start.offset;
			const end = reference.position.end.offset;
			if (content.slice(start, end) !== reference.original) {
				return failure(
					"Obsidian link index is out of date",
					"Obsidian's link index is out of date; retry after the note is indexed.",
					"Wait for the note to be indexed, then retry."
				);
			}
			const replacement = app.fileManager.generateMarkdownLink(
				selected,
				target,
				subpath,
				reference.displayText
			);
			const edit = {
				start,
				end,
				original: reference.original,
				replacement: reference.original.startsWith("!") ? `!${replacement}` : replacement,
			};
			(reference.position.start.line === headerLine ? headerEdits : bodyEdits).push(edit);
		}
	}
	if (
		legacy &&
		mode === "auto" &&
		!item.zoteroChanges &&
		noteKey === citekey &&
		file.path === target &&
		!removedLinks.length &&
		!addedLinks.length &&
		!automaticRemoved.length &&
		!bodyEdits.length &&
		!headerEdits.length &&
		!keptLinks.length &&
		relativeHeader === oldHeader &&
		!missingZoteroLists
	)
		return result("skipped");
	if (
		!legacy &&
		mode === "auto" &&
		!item.zoteroChanges &&
		noteKey === citekey &&
		file.path === target &&
		!removedLinks.length &&
		!addedLinks.length &&
		!automaticRemoved.length &&
		!repairedLinks.length &&
		!bodyEdits.length &&
		!headerEdits.length &&
		!keptLinks.length &&
		!collectionChanged &&
		!missingZoteroLists
	) {
		if (relativeHeader === oldHeader) return result("skipped");
		if (options.prepareOnly)
			return {
				status: "prepared",
				citekey,
				snapshot: content,
				notePath: file.path,
				identicalAttachments: [],
			};
		await options.beforeApply?.();
		try {
			await app.vault.process(file, (current) => {
				if (current !== content)
					throw new Error("The note changed while the update was pending; retry.");
				return current.replace(oldHeader, relativeHeader);
			});
			return result("updated");
		} catch (error) {
			return failure(
				"Attachment link could not be made relative",
				error instanceof Error ? error.message : String(error)
			);
		}
	}
	let editedHeader = oldHeader;
	for (const edit of headerEdits.sort((a, b) => b.start - a.start)) {
		const start = edit.start - headerStart;
		const end = edit.end - headerStart;
		editedHeader = editedHeader.slice(0, start) + edit.replacement + editedHeader.slice(end);
	}
	editedHeader = relativeVaultAttachmentLinks(app, editedHeader);
	let newHeader: string;
	try {
		newHeader = managedHeader(
			editedHeader,
			[
				...subtractLinks(attachmentLinks, addedLinks),
				...selectedAdditions,
				...keptManagedLinks,
			],
			true
		);
	} catch (error) {
		return failure(
			"Managed attachment markers could not be updated",
			error instanceof Error ? error.message : String(error),
			`${error instanceof Error ? error.message : String(error)} Check the note's attachment markers, then retry.`
		);
	}
	const changes: Record<string, unknown> = {
		citekey,
		zotero_item_key: item.itemkey,
		zotero_library_uri: item.libraryURI,
	};
	if (mode === "metadata") {
		for (const field of METADATA_FIELDS) {
			if (field !== "zotero_collections" || item.collections !== undefined)
				changes[field] = generated[field];
		}
		changes.aliases = buildAliases(item.title, fm.aliases);
	} else if (collectionChanged) {
		changes.zotero_collections = generated.zotero_collections ?? [];
	}
	if (missingZoteroTags) changes.zotero_tags = generated.zotero_tags ?? [];
	if (missingZoteroCollections) {
		changes.zotero_collections =
			item.collections === undefined ? [] : generated.zotero_collections ?? [];
	}
	const descriptions = Object.entries(changes)
		.filter(([key, next]) => value(fm[key]) !== value(next))
		.map(([key, next]) =>
			key === "zotero_library_uri"
				? `Set the note's Zotero library identity (zotero_library_uri): ${value(fm[key])} → ${value(next)}`
				: `${key}: ${value(fm[key])} → ${value(next)}`
		);
	if (mode === "metadata" && value(fm.aliases) !== value(changes.aliases)) {
		descriptions.push("Links using an alias that is removed or changed may break.");
	}
	if (file.path !== target)
		descriptions.unshift(
			`Filename: ${file.path} → ${target}. ${backlinkWarning(app, file.path)}`
		);
	if (repairedLinks.length)
		descriptions.push(
			`Replace ${repairedLinks.length} broken attachment link(s) with the Zotero attachment:\n${repairedLinks.map((entry) => `- ${attachmentLinkPath(entry.note) ?? entry.note} → ${attachmentLinkPath(entry.zotero) ?? entry.zotero}`).join("\n")}`
		);
	if (removedSelected.length > repairedLinks.length)
		descriptions.push(
			`Remove ${removedSelected.length - repairedLinks.length} attachment link(s) from the Obsidian note.`
		);
	if (identicalAttachments.length) {
		descriptions.push(
			`Link to ${identicalAttachments.length} Zotero attachment ${identicalAttachments.length === 1 ? "file" : "files"} with identical contents.`
		);
		const redundant = identicalAttachments.filter(
			(pair) => pair.note.path !== pair.zotero.path
		);
		if (redundant.length)
			descriptions.push(
				`Move the duplicate Obsidian files to Trash after checking for shared references; keep the Zotero files:\n${redundant.map((pair) => `- ${pair.note.path} → ${pair.zotero.path}`).join("\n")}`
			);
	}
	if (selectedAdditions.length)
		descriptions.push(
			`Add ${selectedAdditions.length} Zotero attachment link(s) to the Obsidian note.`
		);
	if (keptLinks.length)
		descriptions.push(
			`Keep ${keptLinks.length} unresolved attachment difference(s) in the Obsidian note.`
		);
	if (bodyEdits.length || headerEdits.length)
		descriptions.push(
			`Update ${bodyEdits.length + headerEdits.length} other attachment link(s) in the Obsidian note.`
		);
	if (oldHeader !== newHeader && !removedSelected.length && !selectedAdditions.length)
		descriptions.push("Update the note's managed attachment list.");
	if (!descriptions.length && !item.zoteroChanges && !missingZoteroLists) {
		return keptLinks.length
			? {
					...failure(
						"Attachment differences remain",
						`Attachment differences remain: ${keptLinks.join(", ")}.`,
						`${keptLinks.join(", ")}\n\nReview these links before reconciling the attachments.`
					),
					deferUntilChanged: true,
				}
			: result("skipped");
	}

	const adoption = reassociating
		? `The note records a different Zotero library. Confirm it matches the item in ${item.libraryName || item.libraryURI}.`
		: legacy
			? `The note has no Zotero library URI. Confirm it matches the item in ${item.libraryName || item.libraryURI}.`
			: !oldHeader.includes(START)
				? "The info header has no managed attachment markers. Matching attachment links in it will become Zotero-managed."
				: "";
	const duplicateFiles = identicalAttachments.some((pair) => pair.note.path !== pair.zotero.path);
	const bulkSummary =
		!legacy && mode === "auto" && !item.zoteroChanges
			? [
					file.path !== target ? "Rename notes" : "",
					Object.entries(changes).some(([key, next]) => value(fm[key]) !== value(next))
						? "Update Zotero identifiers"
						: "",
					!oldHeader.includes(START) ? "Adopt managed attachment links" : "",
					oldHeader !== newHeader || bodyEdits.length ? "Update attachment links" : "",
					duplicateFiles
						? "Move duplicate files to Trash after shared-reference checks"
						: "",
				]
					.filter(Boolean)
					.join("; ")
			: undefined;
	if (
		legacy ||
		mode === "metadata" ||
		(!oldHeader.includes(START) && !repairedLinks.length) ||
		file.path !== target ||
		review.length ||
		item.zoteroChanges ||
		duplicateFiles
	) {
		const zoteroChanges = item.zoteroChanges
			? `Your Zotero changes:\n- Item citekey: ${item.zoteroChanges.previousCitekey} → ${citekey}\n- ${item.zoteroChanges.attachmentMoves.length} verified attachment file move(s) or rename(s)${item.zoteroChanges.attachmentMoves.length ? " (shown in the attachment review)" : ""}.`
			: "";
		const diagnosis =
			adoption ||
			(file.path !== target
				? `The note filename does not match the Zotero citation key ${citekey}.`
				: item.zoteroChanges
					? "Review the Obsidian updates for your Zotero citation-key change."
					: review.length
						? "Your attachment choices require changes to the note."
						: duplicateFiles
							? "Identical attachment files can be consolidated."
							: mode === "metadata"
								? "The note's Zotero metadata needs updating."
								: "The note's attachment links are not yet managed.");
		const message = [
			diagnosis,
			zoteroChanges,
			`Saver will update the note:\n${descriptions.join("\n") || "No note changes."}`,
			cancelNote,
		]
			.filter(Boolean)
			.join("\n\n");
		const title = reassociating
			? "Confirm the Zotero library change"
			: legacy
				? "Add the Zotero library and update the note"
				: file.path !== target
					? "Rename and update the note"
					: review.length
						? "Confirm attachment link changes"
						: duplicateFiles
							? "Remove duplicate attachment files"
							: mode === "metadata"
								? "Update Zotero metadata"
								: "Adopt the note's attachment links";
		const decision = await prompt(
			title,
			message,
			[
				{ label: "Apply Obsidian note changes", value: "create", cta: true },
				{ label: "Cancel", value: "cancel" },
			],
			undefined,
			identity,
			bulkSummary
		);
		if (decision !== "create") return result("skipped");
	}
	if (!descriptions.length) return result("skipped");

	if (options.prepareOnly) {
		if ((await app.vault.read(file)) !== content) {
			return failure(
				"Note changed during decision",
				"The note changed while the decision was pending; retry.",
				"Retry the update."
			);
		}
		return {
			status: "prepared",
			citekey,
			snapshot: content,
			identicalAttachments,
			notePath: file.path,
		};
	}
	if (
		identicalAttachments.some((pair) => pair.note.path !== pair.zotero.path) &&
		(!options.beforeApply || !options.trashIdenticalAttachments)
	) {
		return failure(
			"Duplicate attachments could not be verified",
			"Cannot verify duplicate attachments safely; no note changes were made.",
			"Retry the update. No note changes were made."
		);
	}
	await options.beforeApply?.();
	try {
		if (oldHeader !== newHeader || bodyEdits.length) {
			await app.vault.process(file, (current) => {
				if (current !== content)
					throw new Error("The note changed while the update was pending; retry.");
				let updated = current;
				const edits =
					oldHeader === newHeader
						? [...bodyEdits]
						: [
								...bodyEdits,
								{
									start: headerStart,
									end: headerStart + oldHeader.length,
									original: oldHeader,
									replacement: newHeader,
								},
							];
				for (const edit of edits.sort((a, b) => b.start - a.start)) {
					if (updated.slice(edit.start, edit.end) !== edit.original)
						throw new Error("An attachment link changed; retry.");
					updated =
						updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
				}
				return updated;
			});
		}
		await app.fileManager.processFrontMatter(file, (current: Record<string, unknown>) => {
			for (const key of Object.keys(changes)) {
				if (value(current[key]) !== (originalValues[key] ?? value(undefined))) {
					throw new Error(
						`The note's ${key} changed while the update was pending; retry the update.`
					);
				}
			}
			for (const [key, next] of Object.entries(changes)) {
				if (next === undefined) delete current[key];
				else current[key] = next;
			}
		});
		if (file.path !== target) {
			await app.fileManager.renameFile(file, target);
			identity.notePath = file.path;
			new Notice("Literature note renamed.", 5000);
		}
		if (identicalAttachments.length && options.trashIdenticalAttachments) {
			await options.trashIdenticalAttachments(identicalAttachments, file.path);
			const discarded = identicalAttachments.filter(
				(pair) => pair.note.path !== pair.zotero.path
			);
			if (discarded.length) {
				new Notice(
					`Identical attachment copies moved to Trash; Zotero files kept:\n${discarded.map((pair) => `${pair.note.path} → ${pair.zotero.path}`).join("\n")}`,
					15000
				);
			}
		}
		if (keptLinks.length)
			return {
				...failure(
					"Attachment differences remain after update",
					`The note was updated, but attachment differences remain: ${keptLinks.join(", ")}. Review them before considering the attachments reconciled.`,
					`${keptLinks.join(", ")}\n\nThe note was updated. Review these links before considering the attachments reconciled.`
				),
				deferUntilChanged: true,
			};
		return result("updated");
	} catch (error) {
		return failure(
			"Note update may be incomplete",
			`Update may be partial; retry after resolving: ${error instanceof Error ? error.message : String(error)}`,
			`${error instanceof Error ? error.message : String(error)}\n\nCheck the note and attachments, then retry.`
		);
	}
}

export const MISMATCH_PROPERTY = "zotero_note_file_mismatch";
const PRESERVED_ATTACHMENT_KEYS_PROPERTY = "zotero_attachment_preserved_keys";
export const PRESERVED_ATTACHMENT_COPIES_PROPERTY = "zotero_attachment_preserved_copies";
type PreservedCopy = {
	sourceKey: string;
	linkedKey: string;
	sourcePath: string;
	originalPath?: string;
	destinationPath: string;
	sha256: string;
	resourcesOnly?: true;
	resourceSha256?: string;
};

async function recordPreservedCopies(
	app: App,
	file: TFile,
	copies: PreservedCopy[]
): Promise<void> {
	if (!copies.length) return;
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		const existingKeys = Array.isArray(fm[PRESERVED_ATTACHMENT_KEYS_PROPERTY])
			? fm[PRESERVED_ATTACHMENT_KEYS_PROPERTY].filter(
					(key): key is string => typeof key === "string"
				)
			: [];
		const existingCopies: unknown[] = Array.isArray(fm[PRESERVED_ATTACHMENT_COPIES_PROPERTY])
			? fm[PRESERVED_ATTACHMENT_COPIES_PROPERTY]
			: [];
		const replaced = new Set(copies.map((copy) => copy.sourceKey));
		fm[PRESERVED_ATTACHMENT_KEYS_PROPERTY] = [...new Set([...existingKeys, ...replaced])];
		fm[PRESERVED_ATTACHMENT_COPIES_PROPERTY] = [
			...existingCopies.filter(
				(copy) =>
					!copy ||
					typeof copy !== "object" ||
					!replaced.has(String((copy as Record<string, unknown>).sourceKey))
			),
			...copies,
		];
	});
}

export async function recordRecoveredAutomaticAttachments(
	app: App,
	file: TFile,
	item: ZoteroItemPayload,
	paths: Array<{
		itemkey: string;
		sourcePath: string;
		destinationPath: string;
		archivePath?: string;
		archiveDirectory?: string;
	}>
): Promise<void> {
	if (!(app.vault.adapter instanceof FileSystemAdapter))
		throw new Error("The vault path is unavailable.");
	const root = app.vault.adapter.getBasePath();
	const copies: PreservedCopy[] = [];
	for (const entry of paths) {
		const samePath = (a: string, b: string): boolean =>
			path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
		const attachments =
			item.attachments?.filter(
				(current) =>
					current.mode === "linked" &&
					current.path &&
					samePath(current.path, entry.destinationPath) &&
					(entry.archivePath ||
						entry.archiveDirectory ||
						current.itemkey === entry.itemkey)
			) ?? [];
		if (
			(entry.archivePath || entry.archiveDirectory) &&
			item.attachments?.some((current) => current.itemkey === entry.itemkey)
		)
			continue;
		const attachment = attachments.length === 1 ? attachments[0] : undefined;
		if (
			!attachment?.path ||
			!attachment.itemkey ||
			!path.isAbsolute(entry.sourcePath) ||
			!path.isAbsolute(entry.destinationPath) ||
			(entry.archivePath && !path.isAbsolute(entry.archivePath))
		)
			continue;
		if (
			!samePath(attachment.path, entry.destinationPath) ||
			samePath(entry.sourcePath, entry.destinationPath)
		)
			continue;
		const relative = path.relative(root, entry.destinationPath);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new Error("The recovered attachment destination is outside the vault.");
		}
		if (entry.archiveDirectory) {
			copies.push({
				sourceKey: entry.itemkey,
				linkedKey: attachment.itemkey,
				sourcePath: entry.archiveDirectory,
				originalPath: entry.sourcePath,
				destinationPath: entry.destinationPath,
				sha256: await attachmentFingerprint(entry.destinationPath),
				resourcesOnly: true,
				resourceSha256: await verifyAttachmentResourceArchive(
					entry.sourcePath,
					entry.archiveDirectory
				),
			});
			continue;
		}
		await attachmentFingerprint(entry.archivePath ?? entry.sourcePath);
		copies.push({
			sourceKey: entry.itemkey,
			linkedKey: attachment.itemkey,
			sourcePath: entry.archivePath ?? entry.sourcePath,
			...(entry.archivePath ? { originalPath: entry.sourcePath } : {}),
			destinationPath: entry.destinationPath,
			sha256: await attachmentFingerprint(entry.destinationPath),
		});
	}
	await recordPreservedCopies(app, file, copies);
}
const MISMATCH_PREFIX = "==🔴Zotero/note attachment mismatch:";

function mismatchLine(extras: AttachmentMoveCandidate["extras"], copied = false): string {
	const list = (origin: "zotero" | "note"): string =>
		extras
			.filter((extra) => extra.origin === origin)
			.map((extra) => `[[${extra.path}|${path.posix.basename(extra.path)}]]`)
			.join(", ");
	const zotero = list("zotero");
	const note = list("note");
	const missing = extras
		.filter((extra) => extra.origin === "missing")
		.map((extra) => extra.path)
		.join(", ");
	const moved =
		zotero || note
			? copied
				? ` Saver linked these files from both the note and the Zotero item.${zotero ? " The Zotero-only files were copied into the vault." : ""}`
				: ` Saver moved ${zotero && note ? "these files" : zotero ? "the Zotero-only files" : "the note-only files"} into the vault and linked them from both the note and the Zotero item.`
			: "";
	const dropped = missing
		? ` This note${zotero || note ? " also" : ""} linked ${missing}, which pointed to a missing or empty file that no Zotero attachment replaced; Saver removed ${missing.includes(", ") ? "those links" : "that link"}.`
		: "";
	return `${MISMATCH_PREFIX} ${
		[
			zotero ? `only the Zotero item had ${zotero}` : "",
			note ? `only this note linked ${note}` : "",
		]
			.filter(Boolean)
			.join("; ") || "the note's attachment links did not match the Zotero item"
	}.${moved}${dropped} Check that each file belongs to this work, then remove this line and the ${MISMATCH_PROPERTY} property.==`;
}

/** Adds or replaces the mismatch line directly below the info callout, separated by blank lines. */
function withMismatchLine(content: string, line: string): string {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((current) => /^> \[!info\]/i.test(current));
	let end = start + 1;
	while (end < lines.length && lines[end].startsWith(">")) end++;
	let next = end;
	while (next < lines.length && lines[next].trim() === "") next++;
	if (lines[next]?.startsWith(MISMATCH_PREFIX)) {
		lines[next] = line;
		return lines.join(eol);
	}
	const after = next < lines.length ? [""] : [];
	lines.splice(end, next - end, "", line, ...after);
	return lines.join(eol);
}

/**
 * Updates the note after the Zotero companion carried out a confirmed attachment move:
 * relinks the header to the vault files Zotero now uses, records extras, and trashes
 * duplicate or empty note files that nothing else links to.
 */
export async function finishAttachmentMove(
	app: App,
	settings: LitNoteWriterSettings,
	item: ZoteroItemPayload,
	candidate: AttachmentMoveCandidate,
	preservedSources: Array<{
		itemkey: string;
		from: string;
		to: string;
		newKey?: string;
		archivePath?: string;
		archiveDirectory?: string;
		copied?: boolean;
		referenceCheckFailed?: boolean;
	}> = [],
	repairSnapshot?: string
): Promise<{ trashed: string[] }> {
	const notes = getLitNoteFiles(app, settings.litNotesFolder).filter((note) => {
		const fm = app.metadataCache.getFileCache(note)?.frontmatter;
		return fm?.zotero_item_key === item.itemkey && fm?.zotero_library_uri === item.libraryURI;
	});
	if (notes.length !== 1)
		throw new Error(
			"The matching Obsidian note changed or is ambiguous; review it individually."
		);
	const file = notes[0];
	if (app.metadataCache.getFileCache(file)?.frontmatter?.citekey !== item.citekey) {
		throw new Error("The note's citation key changed; review it individually.");
	}
	const preservedKeys = new Set(
		preservedSources
			.filter((source) => source.newKey !== source.itemkey)
			.map((source) => source.itemkey)
	);
	const attachmentItem = preservedKeys.size
		? {
				...item,
				attachments: item.attachments?.filter(
					(attachment) => !preservedKeys.has(attachment.itemkey ?? "")
				),
			}
		: item;
	let problems: AttachmentProblem[] = [];
	let links: string[] = [];
	for (let attempt = 0; attempt < 40; attempt++) {
		problems = [];
		links = await buildAttachmentLinks(app, attachmentItem, file.path, (details) => {
			problems = details;
		});
		if (!problems.length) break;
		await new Promise<void>((resolve) =>
			setTimeoutIn(getMainWindow(app) ?? window, resolve, 250)
		);
	}
	if (problems.length) {
		throw new Error(
			`Obsidian has not indexed the moved files yet: ${problems.map((problem) => problem.path ?? problem.label).join(", ")}. Run the review again.`
		);
	}

	const content = await app.vault.read(file);
	if (repairSnapshot !== undefined && content !== repairSnapshot) {
		throw new Error(
			"The note changed while the attachment was being copied; its links were not changed."
		);
	}
	const oldHeader = header(content);
	if (!oldHeader)
		throw new Error(
			"The note has no Zotero info callout; restore it, then run the review again."
		);
	const headerTargets = new Map<string, number>();
	for (const link of existingAttachmentLinks(oldHeader)) {
		const linkpath = attachmentLinkPath(link);
		const target = linkpath ? attachmentLinkDestination(app, linkpath, file.path) : null;
		if (target) headerTargets.set(target.path, (headerTargets.get(target.path) ?? 0) + 1);
	}
	const incoming = (target: string): number =>
		Object.values(app.metadataCache.resolvedLinks ?? {}).reduce(
			(total, destinations) => total + (destinations[target] ?? 0),
			0
		);
	const trashable =
		repairSnapshot !== undefined ||
		preservedSources.some((source) => source.referenceCheckFailed)
			? []
			: candidate.trashNoteFiles.filter(
					(target) =>
						(headerTargets.get(target) ?? 0) > 0 &&
						incoming(target) === headerTargets.get(target)
				);

	const priorLinks = candidate.automatic
		? await retainLiveNoteLinks(
				app,
				file.path,
				existingAttachmentLinks(relativeVaultAttachmentLinks(app, oldHeader)),
				links
			)
		: [];
	const newHeader = managedHeader(
		oldHeader,
		candidate.automatic
			? [
					...priorLinks,
					...links.filter(
						(link) =>
							!priorLinks.some((previous) => {
								const first = attachmentLinkPath(previous);
								const second = attachmentLinkPath(link);
								const a = first && attachmentLinkDestination(app, first, file.path);
								const b =
									second && attachmentLinkDestination(app, second, file.path);
								return !!a && !!b && a.path === b.path;
							})
					),
				]
			: links,
		true
	);
	await app.vault.process(file, (current) => {
		if (current !== content)
			throw new Error(
				"The note changed while Zotero moved its attachments; run the review again."
			);
		let updated = current.replace(oldHeader, newHeader);
		if (candidate.extras.length)
			updated = withMismatchLine(
				updated,
				mismatchLine(
					candidate.extras,
					repairSnapshot !== undefined ||
						preservedSources.some((source) => source.referenceCheckFailed)
				)
			);
		return updated;
	});
	if (candidate.extras.length) {
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm[MISMATCH_PROPERTY] = true;
		});
	}
	if (repairSnapshot !== undefined && !candidate.automatic) {
		const adapter = app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter))
			throw new Error(
				"The vault path is unavailable; attachment links could not be checked."
			);
		const updatedHeader = header(await app.vault.read(file));
		if (!updatedHeader)
			throw new Error("The note's attachment links could not be checked after repair.");
		const resolved = existingAttachmentLinks(updatedHeader).map((link) => {
			const target = attachmentLinkPath(link);
			const resolvedFile = target ? attachmentLinkDestination(app, target, file.path) : null;
			return resolvedFile instanceof TFile
				? path.resolve(adapter.getBasePath(), resolvedFile.path).toLowerCase()
				: "";
		});
		for (const source of preservedSources) {
			await verifyAttachmentCopy(source.archivePath ?? source.from, source.to);
			if (!resolved.includes(path.resolve(source.to).toLowerCase())) {
				throw new Error(`The note does not link to the copied attachment: ${source.to}`);
			}
		}
	}
	const preservedCopies: PreservedCopy[] = [];
	for (const source of preservedSources) {
		if (source.archiveDirectory) {
			if (!candidate.automatic || !source.newKey)
				throw new Error("Unexpected attachment resource archive.");
			preservedCopies.push({
				sourceKey: source.itemkey,
				linkedKey: source.newKey,
				sourcePath: source.archiveDirectory,
				originalPath: source.from,
				destinationPath: source.to,
				resourcesOnly: true,
				resourceSha256: await verifyAttachmentResourceArchive(
					source.from,
					source.archiveDirectory
				),
				sha256: await attachmentFingerprint(source.to),
			});
			continue;
		}
		const preservedPath = source.archivePath ?? source.from;
		if (source.archivePath) await verifyAttachmentCopy(source.from, source.archivePath);
		if ((candidate.automatic || source.archivePath) && source.newKey) {
			if (source.copied) await verifyAttachmentCopy(preservedPath, source.to);
			preservedCopies.push({
				sourceKey: source.itemkey,
				linkedKey: source.newKey,
				sourcePath: preservedPath,
				...(source.archivePath ? { originalPath: source.from } : {}),
				destinationPath: source.to,
				sha256: await attachmentFingerprint(source.to),
			});
		} else if (
			source.newKey &&
			(await preservedAttachmentMatches(preservedPath, source.to, false))
		) {
			const sha256 = await attachmentFingerprint(source.to);
			if (!(await preservedAttachmentMatches(preservedPath, source.to, false, sha256))) {
				throw new Error(
					`The copied attachment changed while it was being recorded: ${source.to}`
				);
			}
			preservedCopies.push({
				sourceKey: source.itemkey,
				linkedKey: source.newKey,
				sourcePath: preservedPath,
				...(source.archivePath ? { originalPath: source.from } : {}),
				destinationPath: source.to,
				sha256,
			});
		} else if (repairSnapshot !== undefined) {
			throw new Error(`The copied attachment could not be recorded: ${source.to}`);
		}
	}
	await recordPreservedCopies(app, file, preservedCopies);
	if (preservedSources.length && !candidate.automatic) {
		const copied = preservedSources
			.filter((source) => source.copied)
			.map((source) => path.basename(source.to));
		const linked = preservedSources
			.filter((source) => !source.copied)
			.map((source) => path.basename(source.to));
		const actions = [
			copied.length
				? `Copied ${copied.join(", ")} into the vault and linked the copies in Obsidian and Zotero.`
				: "",
			linked.length
				? `Linked the existing vault copies of ${linked.join(", ")} in Obsidian and Zotero.`
				: "",
		]
			.filter(Boolean)
			.join(" ");
		const reason =
			repairSnapshot !== undefined
				? "The originals were kept as safety copies."
				: preservedSources.some((source) => source.referenceCheckFailed)
					? "Zotero could not check for other references."
					: "Another attachment references them.";
		new Notice(`${actions} The Zotero originals remain. ${reason} Verify the references before manually deleting an original.`, 15000);
	}
	const trashed: string[] = [];
	for (const target of trashable) {
		const duplicate = app.vault.getAbstractFileByPath(target);
		if (duplicate instanceof TFile) {
			const snapshot = candidate.trashNoteSnapshots?.find((entry) => entry.path === target);
			const adapter = app.vault.adapter;
			if (!snapshot || !(adapter instanceof FileSystemAdapter)) {
				throw new Error(`Attachment ${target} could not be verified and was not trashed.`);
			}
			await validateTrashNoteFile(adapter.getBasePath(), snapshot);
			await app.fileManager.trashFile(duplicate);
			trashed.push(target);
		}
	}
	return { trashed };
}
