import { App, TFile, parseYaml } from "obsidian";

/**
 * Defensively strip a leading frontmatter block from pasted text, if one is
 * present. Some AI exports occasionally include their own --- fence at the
 * top, which would otherwise stack a second fence with whatever frontmatter
 * the plugin wants to add via processFrontMatter, breaking the note.
 */
export function stripLeadingFrontmatterIfPresent(text: string): {
	body: string;
	existingFrontmatter?: Record<string, unknown>;
} {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { body: text };
	const parsed = parseYaml(match[1]);
	const existing: Record<string, unknown> | undefined =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	return {
		body: text.slice(match[0].length),
		existingFrontmatter: existing,
	};
}

/**
 * Create a new note with body-only content, then attach frontmatter fields
 * via Obsidian's processFrontMatter API. The two-step write guarantees a
 * single, atomic frontmatter fence regardless of any pre-existing YAML
 * (and is the safe way to coexist with other plugins that also write
 * frontmatter, like obsidian-front-matter-timestamps).
 */
export async function createDialogNote(
	app: App,
	path: string,
	bodyMarkdown: string,
	frontmatterFields: Record<string, unknown>
): Promise<TFile> {
	const file = await app.vault.create(path, bodyMarkdown);
	await app.fileManager.processFrontMatter(file, (fm) => {
		for (const [key, value] of Object.entries(frontmatterFields)) {
			if (value !== undefined) {
				fm[key] = value;
			}
		}
	});
	return file;
}

/**
 * Merge fields into an existing note's frontmatter without touching any
 * other part of the file. Used by the append path to update bookkeeping
 * (e.g. updating the count of imported turns) without ever re-writing
 * body text as raw concatenation.
 */
export async function updateFrontMatter(
	app: App,
	file: TFile,
	fields: Record<string, unknown>
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined) {
				delete fm[key];
			} else {
				fm[key] = value;
			}
		}
	});
}

/**
 * Overwrite an existing note with body-only content, then update its frontmatter fields
 * via Obsidian's processFrontMatter API.
 */
export async function overwriteDialogNote(
	app: App,
	file: TFile,
	bodyMarkdown: string,
	frontmatterFields: Record<string, unknown>
): Promise<void> {
	await app.vault.modify(file, bodyMarkdown);
	await app.fileManager.processFrontMatter(file, (fm) => {
		for (const [key, value] of Object.entries(frontmatterFields)) {
			if (value === undefined) {
				delete fm[key];
			} else {
				fm[key] = value;
			}
		}
	});
}
