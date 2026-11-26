import { Notice, TFile } from "obsidian";
import type { App, Plugin, TAbstractFile } from "obsidian";
import { askNoteDecision } from "./decisionModal";
import { linkingNotes } from "./noteMerge";

const ATTACHMENT_NOTE = /\.(?:pdf|html?|docx?|pptx?|epub|txt)\.md$/i;
const TIMESTAMP_KEY = /^(?:created|modified|updated)(?:[ _-]?(?:date|at|time|on))?$|^date[ _-]?(?:created|modified|updated)$/i;

/**
 * True for a note such as "paper.pdf.md" that has no text: Obsidian creates one when a link to a
 * missing attachment ("paper.pdf") is clicked. Timestamp properties added by other plugins are allowed.
 */
export function isStrayAttachmentNote(name: string, content: string): boolean {
	if (!ATTACHMENT_NOTE.test(name)) return false;
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/);
	const properties = match ? match[1] : "";
	const body = match ? content.slice(match[0].length) : content;
	if (body.trim()) return false;
	return properties.split(/\r?\n/).filter((line) => line.trim()).every((line) => {
		const property = line.match(/^([^\s:#][^:]*):[ \t]*\S/);
		return !!property && TIMESTAMP_KEY.test(property[1].trim());
	});
}

export async function findStrayAttachmentNotes(app: App, files: TFile[] = app.vault.getMarkdownFiles()): Promise<TFile[]> {
	const stray: TFile[] = [];
	for (const file of files) {
		if (!ATTACHMENT_NOTE.test(file.name)) continue;
		try {
			if (isStrayAttachmentNote(file.name, await app.vault.cachedRead(file))) stray.push(file);
		} catch (error) {
			console.warn(`Could not check ${file.path}`, error);
		}
	}
	return stray;
}

const declined = new Set<string>();
let offering = false;

/** Explain the notes, ask permission, then move the ones that are still empty to trash. */
export async function offerStrayAttachmentNoteCleanup(app: App, candidates?: TFile[], automatic = false): Promise<void> {
	if (offering) return;
	offering = true;
	try {
		const files = (candidates ?? await findStrayAttachmentNotes(app))
			.filter((file) => !automatic || !declined.has(file.path));
		if (!files.length) {
			if (!automatic) new Notice("No empty notes created from broken attachment links were found.");
			return;
		}
		const listed = files.slice(0, 20).map((file) => {
			const sources = linkingNotes(app, file);
			return `- ${file.path}${sources.length ? ` (linked from ${sources.slice(0, 3).join(", ")}${sources.length > 3 ? ", …" : ""})` : ""}`;
		});
		if (files.length > 20) listed.push(`- And ${files.length - 20} more`);
		const decision = await askNoteDecision(app, files.length === 1 ? "Empty note created from a broken attachment link" : "Empty notes created from broken attachment links",
			`${files.length === 1 ? "This note has" : "These notes have"} no text, apart from any date properties. When you click a link to an attachment that is missing from the vault, such as [[paper.pdf]], Obsidian creates an empty note named paper.pdf.md instead. The note does not contain the attachment, and links to the attachment then point to it.\n\n${listed.join("\n")}\n\nMove ${files.length === 1 ? "it" : "them"} to trash? Your trash settings apply, so ${files.length === 1 ? "it" : "they"} can be restored. A note that gains text before you confirm is kept.`,
			[{ label: "Move to trash", value: "create", cta: true }, { label: "Keep", value: "cancel" }]);
		if (decision !== "create") {
			for (const file of files) declined.add(file.path);
			return;
		}
		let trashed = 0;
		const kept: string[] = [];
		for (const file of files) {
			try {
				const current = app.vault.getAbstractFileByPath(file.path);
				if (!(current instanceof TFile) || !isStrayAttachmentNote(current.name, await app.vault.read(current))) {
					kept.push(file.path);
					continue;
				}
				await app.fileManager.trashFile(current);
				trashed++;
			} catch (error) {
				console.error(`Could not move ${file.path} to trash`, error);
				kept.push(file.path);
			}
		}
		new Notice(`Moved ${trashed} empty ${trashed === 1 ? "note" : "notes"} to trash.${kept.length ? ` Kept ${kept.length} that changed or could not be moved: ${kept.join(", ")}.` : ""}`, 10000);
	} finally {
		offering = false;
	}
}

function announce(app: App, files: TFile[]): void {
	const pending = files.filter((file) => !declined.has(file.path));
	if (!pending.length) return;
	const notice = new Notice(`${pending.length === 1 ? `Obsidian created an empty note, ${pending[0].name}, from a broken attachment link` : `Found ${pending.length} empty notes created from broken attachment links`}. Click this message to review ${pending.length === 1 ? "it" : "them"}.`, 15000);
	notice.messageEl.addEventListener("click", () => {
		notice.hide();
		void offerStrayAttachmentNoteCleanup(app, pending, true);
	});
}

export function registerStrayAttachmentNotes(plugin: Plugin): void {
	const { app } = plugin;
	plugin.addCommand({
		id: "remove-empty-attachment-notes",
		name: "Remove empty notes created from broken attachment links",
		callback: () => { void offerStrayAttachmentNoteCleanup(app); },
	});
	app.workspace.onLayoutReady(() => {
		void findStrayAttachmentNotes(app).then((files) => announce(app, files));
		plugin.registerEvent(app.vault.on("create", (file: TAbstractFile) => {
			if (file instanceof TFile && ATTACHMENT_NOTE.test(file.name)) {
				void findStrayAttachmentNotes(app, [file]).then((files) => announce(app, files));
			}
		}));
	});
}
