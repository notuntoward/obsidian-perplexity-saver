import { expect, it, vi } from "vitest";
import type { App } from "obsidian";
import path from "path";
import { createPreservedAttachmentsReport } from "../../src/litNote/preservedAttachmentsReport";

it("lists recorded originals without claiming they are safe to delete or overwriting an existing report", async () => {
	const note = { path: "lit/paper.md" };
	const source = path.resolve("storage", "paper.pdf");
	const destination = path.resolve("vault", "paper.pdf");
	const create = vi.fn(async () => ({}));
	const openLinkText = vi.fn(async () => {});
	const app = {
		vault: {
			getAbstractFileByPath: (name: string) => name === "Preserved Zotero attachment files.md" ? {} : null,
			getMarkdownFiles: () => [note],
			create,
		},
		metadataCache: {
			getFileCache: () => ({
				frontmatter: {
					zotero_item_key: "ITEM",
					zotero_library_uri: "https://api.zotero.org/groups/42",
					zotero_attachment_preserved_copies: [
						{ sourceKey: "OLD", linkedKey: "COPY", sourcePath: source, destinationPath: destination },
						{ sourceKey: "SAME", linkedKey: "SAME", sourcePath: source, destinationPath: destination },
						{ sourceKey: "ARCHIVED", linkedKey: "NEW", sourcePath: source, originalPath: path.resolve("storage", "old.pdf"), destinationPath: destination },
						{ sourceKey: "RESOURCES", linkedKey: "NEW", sourcePath: path.resolve("archive", "contents"), originalPath: source, destinationPath: destination, resourcesOnly: true },
						{ sourcePath: "relative" },
					],
				},
			}),
		},
		fileManager: { generateMarkdownLink: () => "[[lit/paper]]" },
		workspace: { openLinkText },
	} as unknown as App;

	await createPreservedAttachmentsReport(app);

	expect(create).toHaveBeenCalledOnce();
	const [name, content] = create.mock.calls[0] as unknown as [string, string];
	expect(name).toBe("Preserved Zotero attachment files 2.md");
	expect(content).toContain("[[lit/paper]]");
	expect(content).toContain("zotero://select/groups/42/items/ITEM");
	expect(content).toContain(source);
	expect(content).toContain(destination);
	expect(content).toContain("open folder");
	expect(content).toContain("Other backups may exist");
	expect(content).toContain("no other item or application needs the original");
	expect(content).toContain("Archive:");
	expect(content).toContain("Resource archive (main file was missing)");
	expect(content).toContain("Former Zotero storage path:");
	expect(content).toContain("An earlier repair used two Zotero attachments");
	expect(content.match(/An earlier repair used two Zotero attachments/g)).toHaveLength(1);
	expect(content).toContain("1 recorded entry could not be displayed");
	expect(openLinkText).toHaveBeenCalledWith(name, "", false);
});
