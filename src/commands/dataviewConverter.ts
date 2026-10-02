import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { App, Notice, TFile, normalizePath } from "obsidian";
import {
	ConversionResult,
	convertDataviewPropsToFrontmatter,
} from "../litNote/dataviewConverter";
import { writeLitNote } from "../litNote/writeLitNote";
import { LitNoteSelectModal, parseLitNoteInfo } from "./getLitNoteLink";
import type { ZoteroClient } from "../zotero/zoteroClient";

const LOG_FILE_PATH = "Scratch Space/Dataview Property Movement Log.md";
export const CONVERTED_NOTES_DIR = path.join(os.homedir(), "tmp", "lit_notes_converted");

export function getConvertedNoteDiskPath(
	notePath: string,
	litNotesFolder: string
): string {
	const normNotePath = normalizePath(notePath);
	const normLitFolder = normalizePath(litNotesFolder || "").trim();

	let relPath = normNotePath;
	if (normLitFolder && normNotePath.toLowerCase().startsWith(normLitFolder.toLowerCase() + "/")) {
		relPath = normNotePath.slice(normLitFolder.length + 1);
	} else {
		relPath = normNotePath.split("/").pop() || normNotePath;
	}

	return path.join(CONVERTED_NOTES_DIR, ...relPath.split("/"));
}

export async function writeConvertedNoteToDisk(
	targetDiskPath: string,
	content: string
): Promise<void> {
	const dir = path.dirname(targetDiskPath);
	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.writeFile(targetDiskPath, content, "utf8");
}

import { getLitNoteFiles } from "../litNote/litNoteFinder";
export { getLitNoteFiles };

export function getScratchPathForNote(
	notePath: string,
	litNotesFolder: string
): string {
	const normNotePath = normalizePath(notePath);
	const normLitFolder = normalizePath(litNotesFolder || "").trim();

	if (normLitFolder && normNotePath.toLowerCase().startsWith(normLitFolder.toLowerCase() + "/")) {
		return normalizePath(`Scratch Space/${normNotePath}`);
	}

	const filename = normNotePath.split("/").pop() || normNotePath;
	const subPath = normLitFolder ? `${normLitFolder}/${filename}` : filename;
	return normalizePath(`Scratch Space/${subPath}`);
}

export interface ConvertAndWriteResult {
	conversion: ConversionResult;
	targetFile?: TFile;
	targetPath?: string;
}

/**
 * Underlying note writing code shared by both
 * 'All notes: Dataview to file props' and 'Selected note: Dataview to file props'.
 *
 * Converts a note's Dataview callout properties to file properties (frontmatter)
 * with blank lines above and below the callout, and writes the note to
 * disk at `~/tmp/lit_notes_converted`.
 */
export async function convertAndWriteNote(
	app: App,
	file: TFile,
	settings: { litNotesFolder: string },
	zoteroClient?: ZoteroClient
): Promise<ConvertAndWriteResult> {
	const content = await app.vault.read(file);
	const res = await convertDataviewPropsToFrontmatter(
		content,
		file.path,
		zoteroClient
	);

	if (!res.success || res.skipped || !res.updatedContent) {
		return { conversion: res };
	}

	const targetDiskPath = getConvertedNoteDiskPath(
		file.path,
		settings.litNotesFolder
	);

	await writeConvertedNoteToDisk(targetDiskPath, res.updatedContent);

	return {
		conversion: res,
		targetPath: targetDiskPath,
	};
}

export async function writeNoteToScratchSpace(
	app: App,
	targetPath: string,
	content: string
): Promise<TFile> {
	return await writeLitNote(app, targetPath, content);
}

export async function appendToLogFile(
	app: App,
	results: ConversionResult[],
	modeLabel: string,
	isZoteroOnline?: boolean
): Promise<void> {
	const total = results.length;
	const converted = results.filter((r) => r.success && !r.skipped);
	const skipped = results.filter((r) => r.skipped);

	const notesWithoutAuthors = converted.filter(
		(c) =>
			!c.updatedFm?.authors ||
			(Array.isArray(c.updatedFm.authors) && c.updatedFm.authors.length === 0)
	);
	const notesWithUnconvertedFields = converted.filter(
		(c) => c.unconvertedDataviewFields && c.unconvertedDataviewFields.length > 0
	);

	const now = new Date().toISOString().replace("T", " ").slice(0, 19);

	const lines: string[] = [
		`# Dataview Property Movement Log (${modeLabel})`,
		`**Execution Time**: ${now}`,
		`**Output Directory**: \`${CONVERTED_NOTES_DIR}\``,
	];

	if (isZoteroOnline !== undefined) {
		lines.push(
			`**Zotero Status**: ${isZoteroOnline ? "Online" : "Offline / Unreachable (used fallback author parser)"}`
		);
	}

	lines.push(
		"",
		"## Summary",
		`- **Total Notes Processed**: ${total}`,
		`- **Successfully Converted**: ${converted.length}`,
		`- **Skipped**: ${skipped.length}`,
		`- **Notes without Authors Property**: ${notesWithoutAuthors.length}`,
		`- **Notes with Unconverted Callout Fields**: ${notesWithUnconvertedFields.length}`,
		""
	);

	if (isZoteroOnline === false) {
		lines.push(
			"> [!WARNING] Zotero Offline",
			"> Local Zotero was offline or unreachable on port 23119 during conversion. Any notes with unformatted author strings were converted using fallback author parsing instead of Zotero structured creators.",
			""
		);
	}

	if (notesWithoutAuthors.length > 0) {
		lines.push("## Notes Without Authors Property");
		lines.push("> [!WARNING] Missing Authors Property");
		lines.push("> The following notes could not be converted to have an `authors` file property because no creator/author Dataview field was found:");
		lines.push("");
		for (const n of notesWithoutAuthors) {
			lines.push(`- **[[${n.filePath}]]**: No author or creator Dataview field found`);
		}
		lines.push("");
	}

	if (notesWithUnconvertedFields.length > 0) {
		lines.push("## Notes With Unconverted Dataview Fields Retained in Callout");
		lines.push("> [!NOTE] Unconverted Dataview Fields");
		lines.push("> The following notes contain Dataview fields that were left inside the callout:");
		lines.push("");
		for (const n of notesWithUnconvertedFields) {
			const fieldsSummary = n.unconvertedDataviewFields!
				.map((f) => `'${f.rawKey}' ("${f.value}")`)
				.join(", ");
			lines.push(`- **[[${n.filePath}]]**: ${fieldsSummary}`);
		}
		lines.push("");
	}

	if (skipped.length > 0) {
		lines.push("## Skipped Notes");
		for (const s of skipped) {
			lines.push(`- **[[${s.filePath}]]**: ${s.reason || "Skipped"}`);
		}
		lines.push("");
	}

	if (converted.length > 0) {
		lines.push("## Converted Notes");
		for (const c of converted) {
			lines.push(`### [[${c.filePath}]]`);
			if (c.changesMade && c.changesMade.length > 0) {
				for (const change of c.changesMade) {
					lines.push(`- ${change}`);
				}
			} else {
				lines.push("- Properties reformatted cleanly.");
			}
			lines.push("");
		}
	}

	lines.push("---\n");

	const newLogContent = lines.join("\n");
	const existingLog = app.vault.getAbstractFileByPath(LOG_FILE_PATH);

	if (existingLog && existingLog instanceof TFile) {
		const oldContent = await app.vault.read(existingLog);
		await app.vault.modify(existingLog, `${newLogContent}\n${oldContent}`);
	} else {
		await writeNoteToScratchSpace(app, LOG_FILE_PATH, newLogContent);
	}
}

export function registerDataviewConverterCommands(plugin: {
	app: App;
	addCommand: (cmd: unknown) => unknown;
	settings: {
		litNotesFolder: string;
	};
	zoteroClient?: ZoteroClient;
}): void {
	// Command 1: All notes: Dataview to file props
	plugin.addCommand({
		id: "all-notes-dataview-to-file-props",
		name: "All notes: Dataview to file props",
		callback: async () => {
			const files = getLitNoteFiles(plugin.app, plugin.settings.litNotesFolder);
			if (files.length === 0) {
				new Notice(`No literature notes found in '${plugin.settings.litNotesFolder}'.`);
				return;
			}

			let isZoteroOnline = false;
			if (plugin.zoteroClient) {
				try {
					isZoteroOnline = await plugin.zoteroClient.isAvailable(1500);
				} catch {
					isZoteroOnline = false;
				}
			}

			if (!isZoteroOnline) {
				new Notice(
					"Warning: Zotero is closed or unreachable on port 23119. Author lookups from Zotero will fallback to note author strings.",
					7000
				);
			}

			const notice = new Notice(
				`Processing ${files.length} literature notes...`,
				0
			);

			const results: ConversionResult[] = [];

			try {
				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					notice.setMessage(`Processing note ${i + 1}/${files.length}: ${file.basename}...`);

					try {
						const { conversion } = await convertAndWriteNote(
							plugin.app,
							file,
							plugin.settings,
							plugin.zoteroClient
						);
						results.push(conversion);
					} catch (err: any) {
						console.error(`Error processing note ${file.path}:`, err);
						results.push({
							success: false,
							skipped: true,
							reason: `Error processing note: ${err?.message || String(err)}`,
							filePath: file.path,
							originalContent: "",
						});
					}
				}

				try {
					await appendToLogFile(plugin.app, results, "All Notes", isZoteroOnline);
				} catch (logErr) {
					console.error("Error writing to movement log:", logErr);
				}

				const convertedCount = results.filter((r) => r.success && !r.skipped).length;
				const skippedCount = results.filter((r) => r.skipped).length;

				notice.setMessage(
					`Batch complete! Converted ${convertedCount} note(s), skipped ${skippedCount}. Written to ${CONVERTED_NOTES_DIR}.`
				);
			} catch (batchErr: any) {
				console.error("Batch processing error:", batchErr);
				notice.setMessage("Batch processing encountered an error.");
			} finally {
				window.setTimeout(() => notice.hide(), 6000);
			}
		},
	});

	// Command 2: Selected note: Dataview to file props
	plugin.addCommand({
		id: "selected-note-dataview-to-file-props",
		name: "Selected note: Dataview to file props",
		callback: async () => {
			const files = getLitNoteFiles(plugin.app, plugin.settings.litNotesFolder);
			if (files.length === 0) {
				new Notice(`No literature notes found in '${plugin.settings.litNotesFolder}'.`);
				return;
			}

			const notesInfo = await Promise.all(
				files.map((f) => parseLitNoteInfo(plugin.app, f))
			);

			const modal = new LitNoteSelectModal(
				plugin.app,
				notesInfo,
				async (selectedNote) => {
					let isZoteroOnline = false;
					if (plugin.zoteroClient) {
						try {
							isZoteroOnline = await plugin.zoteroClient.isAvailable(1500);
						} catch {
							isZoteroOnline = false;
						}
					}

					if (!isZoteroOnline) {
						new Notice(
							"Warning: Zotero is closed or unreachable on port 23119. Converting using note author fallback.",
							5000
						);
					}

					try {
						const { conversion, targetPath } = await convertAndWriteNote(
							plugin.app,
							selectedNote.file,
							plugin.settings,
							plugin.zoteroClient
						);

						if (conversion.skipped || !conversion.success) {
							new Notice(
								`Note skipped: ${conversion.reason || "Unable to determine structured creators"}`
							);
							await appendToLogFile(plugin.app, [conversion], "Selected Note", isZoteroOnline);
							return;
						}

						await appendToLogFile(plugin.app, [conversion], "Selected Note", isZoteroOnline);
						new Notice(`Saved converted note to ${targetPath}`);
					} catch (err: any) {
						console.error("Error converting selected note:", err);
						new Notice(`Error converting note: ${err?.message || String(err)}`);
					}
				}
			);

			modal.open();
		},
	});
}
