import { App, Notice, Plugin } from "obsidian";
import path from "path";
import { pathToFileURL } from "url";
import { PRESERVED_ATTACHMENT_COPIES_PROPERTY } from "./syncLitNote";
import { getNoteZoteroSelectUri } from "./zoteroUri";

function code(value: string): string {
	const fence = "`".repeat(Math.max(1, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length + 1)));
	return `${fence} ${value} ${fence}`;
}

function fileUri(value: string): string {
	return pathToFileURL(value).href.replace(/[()]/g, (character) => encodeURIComponent(character));
}

export async function createPreservedAttachmentsReport(app: App): Promise<void> {
	let reportPath = "Preserved Zotero attachment files.md";
	let suffix = 2;
	while (app.vault.getAbstractFileByPath(reportPath)) reportPath = `Preserved Zotero attachment files ${suffix++}.md`;
	const rows: string[] = [];
	let invalid = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		const entries: unknown[] = Array.isArray(fm?.[PRESERVED_ATTACHMENT_COPIES_PROPERTY])
			? fm[PRESERVED_ATTACHMENT_COPIES_PROPERTY] : [];
		for (const entry of entries) {
			const note = app.fileManager.generateMarkdownLink(file, reportPath);
			if (!entry || typeof entry !== "object") {
				invalid++;
				rows.push(`- ${note}: a preserved-file record is invalid. Inspect the note properties.`);
				continue;
			}
			const { sourceKey, linkedKey, sourcePath, originalPath, destinationPath, resourcesOnly } = entry as Record<string, unknown>;
			if (typeof sourceKey !== "string" || typeof linkedKey !== "string" ||
				typeof sourcePath !== "string" || typeof destinationPath !== "string" ||
				!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
				invalid++;
				rows.push(`- ${note}: a preserved-file record is incomplete. Inspect the note properties.`);
				continue;
			}
			const itemURI = typeof fm?.zotero_item_key === "string"
				? getNoteZoteroSelectUri({ itemkey: fm.zotero_item_key, libraryURI: typeof fm.zotero_library_uri === "string" ? fm.zotero_library_uri : undefined })
				: "";
			rows.push([
				`- [ ] ${note}${itemURI ? ` | [Open Zotero item](${itemURI})` : ""}`,
				`  - ${resourcesOnly === true ? "Resource archive (main file was missing)" : typeof originalPath === "string" ? "Archive" : "Original"}: ${code(sourcePath)} ([open folder](${fileUri(resourcesOnly === true ? sourcePath : path.dirname(sourcePath))}))`,
				...(typeof originalPath === "string" ? [`  - Former Zotero storage path: ${code(originalPath)}`] : []),
				`  - Vault attachment: ${code(destinationPath)} ([open file](${fileUri(destinationPath)}))`,
				...(sourceKey !== linkedKey && typeof originalPath !== "string" ? ["  - An earlier repair used two Zotero attachments. Check the original attachment in Zotero before deleting this file."] : []),
			].join("\n"));
		}
	}
	const content = [
		"# Preserved Zotero attachment files",
		"This is a snapshot of copies recorded in literature notes. Other backups may exist, and listed files may have moved or been deleted.",
		"Before deleting an original manually, check that the vault attachment opens in Zotero and Obsidian and that no other item or application needs the original. The files may differ. Nothing is deleted by this report.",
		...(invalid ? [`${invalid} recorded ${invalid === 1 ? "entry could" : "entries could"} not be displayed; inspect the note properties for details.`] : []),
		rows.length ? rows.join("\n\n") : "No recorded preserved attachment files were found.",
	].join("\n\n") + "\n";
	await app.vault.create(reportPath, content);
	await app.workspace.openLinkText(reportPath, "", false);
}

export function registerPreservedAttachmentsReport(plugin: Plugin): void {
	plugin.addCommand({
		id: "list-preserved-zotero-attachments",
		name: "List preserved Zotero attachment files",
		callback: () => {
			void createPreservedAttachmentsReport(plugin.app).catch((error: unknown) => {
				console.error("Could not create preserved attachment report", error);
				new Notice(`Could not create the preserved attachment report: ${error instanceof Error ? error.message : String(error)}`, 10000);
			});
		},
	});
}
