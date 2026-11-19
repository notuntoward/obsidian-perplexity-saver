import { Notice, type App, type TFile } from "obsidian";
import { askNoteDecision } from "./decisionModal";
import {
	findTranscriptCandidates,
	headingsFromText,
	normalizeTranscriptHeading,
	sameTranscriptHeading,
} from "./transcriptSection";

/** A note whose transcript sits under a heading other than the configured one. */
export interface StrandedTranscript {
	file: TFile;
	/** Current heading text, as the metadata cache reports it. */
	heading: string;
	/** Zero-based line of the heading. */
	line: number;
	cueLines: number;
}

const ATX_HEADING = /^( {0,3}#{1,6}[ \t]+)(.*?)([ \t]+#+)?([ \t]*)(\r?)$/;

/**
 * Rewrite one ATX heading line to `newName`, keeping its level. Returns false, leaving the note untouched, when
 * the line is no longer that heading (the note changed since it was scanned) or is not an ATX heading.
 */
export async function renameTranscriptHeading(app: App, item: StrandedTranscript, newName: string): Promise<boolean> {
	let renamed = false;
	await app.vault.process(item.file, (content) => {
		const lines = content.split("\n");
		const match = ATX_HEADING.exec(lines[item.line] ?? "");
		if (!match || !sameTranscriptHeading(match[2], item.heading)) return content;
		lines[item.line] = `${match[1]}${newName}${match[3] ?? ""}${match[4]}${match[5]}`;
		renamed = true;
		return lines.join("\n");
	});
	return renamed;
}

/** The unambiguous transcript heading of one note when it is not the configured name, else null. */
async function strandedTranscriptOf(app: App, file: TFile, wanted: string): Promise<StrandedTranscript | null> {
	const headings = app.metadataCache.getFileCache(file)?.headings;
	if (!headings?.length || headings.some((h) => sameTranscriptHeading(h.heading, wanted))) return null;
	const content = await app.vault.cachedRead(file);
	const candidates = findTranscriptCandidates(content, headings);
	if (candidates.length !== 1) return null;
	const { heading, cueLines } = candidates[0];
	const line = content.split("\n")[heading.position.start.line] ?? "";
	if (!ATX_HEADING.test(line)) return null;
	return { file, heading: heading.heading, line: heading.position.start.line, cueLines };
}

/** Scan the vault for notes with an unambiguous transcript under a heading other than `headingName`. */
export async function findStrandedTranscripts(app: App, headingName: string): Promise<StrandedTranscript[]> {
	const wanted = normalizeTranscriptHeading(headingName);
	const found: StrandedTranscript[] = [];
	let scanned = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		const item = await strandedTranscriptOf(app, file, wanted);
		if (item) found.push(item);
		// Let the UI breathe on large vaults.
		if (++scanned % 50 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	}
	return found;
}

const PREVIEW_LIMIT = 12;

/** Command: preview, then rename, every stranded transcript heading to the configured name. */
export async function renameStrandedTranscriptHeadings(app: App, headingName: string): Promise<void> {
	const wanted = normalizeTranscriptHeading(headingName);
	const progress = new Notice("Looking for transcripts under other headings...", 0);
	let stranded: StrandedTranscript[];
	try {
		stranded = await findStrandedTranscripts(app, wanted);
	} finally {
		progress.hide();
	}
	if (!stranded.length) {
		new Notice(`No notes have a transcript under a heading other than "${wanted}".`);
		return;
	}
	const preview = stranded.slice(0, PREVIEW_LIMIT).map((item) => `${item.file.path}: "${item.heading}"`);
	if (stranded.length > PREVIEW_LIMIT) preview.push(`...and ${stranded.length - PREVIEW_LIMIT} more`);
	const decision = await askNoteDecision(
		app,
		"Rename transcript headings",
		`${stranded.length} note${stranded.length === 1 ? " has" : "s have"} a transcript under another heading. ` +
			`Rename the heading to "${wanted}"? Only the heading line changes.\n\n${preview.join("\n")}`,
		[
			{ label: `Rename ${stranded.length}`, value: "rename", cta: true },
			{ label: "Cancel", value: "cancel" },
		]
	);
	if (decision !== "rename") return;
	let renamed = 0;
	for (const item of stranded) {
		try {
			if (await renameTranscriptHeading(app, item, wanted)) renamed++;
		} catch (error) {
			console.error(`Perplexity Saver: could not rename the transcript heading in ${item.file.path}`, error);
		}
	}
	const skipped = stranded.length - renamed;
	new Notice(`Renamed ${renamed} transcript heading${renamed === 1 ? "" : "s"} to "${wanted}"` +
		(skipped ? `; skipped ${skipped} that changed or could not be edited.` : "."));
}

const BUTTON_LIMIT = 3;

/**
 * Explain a failed transcript lookup. When the note has several sections that look like a transcript, offer to
 * rename one to the configured heading, since picking between them silently could show the wrong text.
 */
export async function notifyNoTranscript(
	app: App,
	file: TFile,
	headingName: string,
	createFromYoutube?: () => void | Promise<void>
): Promise<void> {
	const wanted = normalizeTranscriptHeading(headingName);
	const message = `No timestamped transcript under a "${wanted}" heading in ${file.basename}.`;
	const plain = new Notice(message);
	let choices: ReturnType<typeof findTranscriptCandidates> = [];
	try {
		const content = await app.vault.cachedRead(file);
		const cached = app.metadataCache.getFileCache(file)?.headings;
		const headings = cached?.every((heading) =>
			!!heading.position?.start && Number.isFinite(heading.position.start.offset) &&
			!!heading.position?.end && Number.isFinite(heading.position.end.offset))
			? cached : headingsFromText(content);
		const candidates = headings.length ? findTranscriptCandidates(content, headings) : [];
		choices = candidates.filter(({ heading }) => !sameTranscriptHeading(heading.heading, wanted)).slice(0, BUTTON_LIMIT);
	} catch (error) {
		console.error("Perplexity Saver: could not look for other transcript headings", error);
	}
	if (!choices.length && !createFromYoutube) return;
	plain.hide();
	const notice = new Notice(message, 15000);
	const el = notice.messageEl;
	if (choices.length) el.createDiv({ text: "These headings also look like transcripts:" });
	for (const { heading, cueLines } of choices) {
		const item: StrandedTranscript = { file, heading: heading.heading, line: heading.position.start.line, cueLines };
		el.createEl("button", { text: `Rename "${heading.heading}" to "${wanted}"` }).addEventListener("click", () => {
			notice.hide();
			void renameTranscriptHeading(app, item, wanted).then((renamed) => {
				new Notice(renamed ? `Renamed the heading to "${wanted}". Try again.` : "The note changed; the heading was not renamed.");
			}).catch((error: unknown) => {
				console.error("Perplexity Saver: could not rename the transcript heading", error);
				new Notice("Could not rename the transcript heading.");
			});
		});
	}
	if (createFromYoutube) {
		el.createEl("button", { text: "Create from YouTube", cls: "mod-cta" }).addEventListener("click", () => {
			notice.hide();
			void Promise.resolve(createFromYoutube()).catch((error: unknown) => {
				console.error(`Perplexity Saver: could not create a transcript for ${file.path}`, error);
				new Notice("Could not create the transcript.");
			});
		});
	}
}
