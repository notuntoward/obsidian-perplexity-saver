import { parseYaml } from "obsidian";
import { buildAliases, cleanFieldValue, formatObsidianDate } from "./buildLitNote";
import { parseOldFormatNote } from "./oldFormatReader";

export interface LitNoteMetadata {
	title: string;
	aliases: string[];
	citekey: string;
	publication_date?: string;
	authors?: string[];
	isOldFormat: boolean;
	frontmatter: Record<string, unknown>;
}

/**
 * Check whether note body contains legacy Dataview callout property lines.
 */
export function hasLegacyDataviewProperties(contentOrBody: string): boolean {
	return /^(?:>\s*)?(?:\*\*)?(?:Author|FirstAuthor|Title|Date|Citekey|ZoteroItemKey)(?:\*\*)?::/im.test(
		contentOrBody
	);
}

/**
 * Canonical reader for literature notes.
 *
 * Reads new-format frontmatter properties with full fidelity.
 * During migration, if a note lacks frontmatter title or contains legacy
 * Dataview properties, it delegates to `parseOldFormatNote`.
 * When all notes are migrated, this transitional delegation can be removed.
 */
export function readLitNote(
	rawContent: string,
	fallbackStem = ""
): LitNoteMetadata {
	const content = rawContent.replace(/\r\n/g, "\n");
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

	let frontmatter: Record<string, unknown> = {};
	if (fmMatch) {
		try {
			const parsed = parseYaml(fmMatch[1]);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				frontmatter = parsed as Record<string, unknown>;
			}
		} catch {
			// Parsing failure falls through to old-format reader
		}
	}

	const fmTitle = frontmatter.title || frontmatter.Title;
	const isUnconverted = hasLegacyDataviewProperties(content);

	// If frontmatter title exists and no legacy properties are present, read as new format
	if (fmTitle && !isUnconverted) {
		const cleanTitle = cleanFieldValue(String(fmTitle));
		const rawDate = frontmatter.publication_date || frontmatter.date;
		const pubDate = rawDate ? formatObsidianDate(rawDate) : undefined;
		const citekey = String(
			frontmatter.citekey ||
			frontmatter["citation key"] ||
			frontmatter["citation_key"] ||
			fallbackStem
		).trim();

		const authors = Array.isArray(frontmatter.authors)
			? frontmatter.authors.map((a) => cleanFieldValue(String(a)))
			: undefined;

		return {
			title: cleanTitle || fallbackStem,
			aliases: buildAliases(cleanTitle || fallbackStem, frontmatter.aliases),
			citekey: citekey || fallbackStem,
			publication_date: pubDate || undefined,
			authors,
			isOldFormat: false,
			frontmatter,
		};
	}

	// Transitional fallback: delegate to Old-Format Reader
	const oldNote = parseOldFormatNote(content, fallbackStem);
	const resolvedTitle = oldNote.title || fallbackStem;
	const pubDate = oldNote.date ? formatObsidianDate(oldNote.date) : undefined;

	return {
		title: resolvedTitle,
		aliases: buildAliases(resolvedTitle, oldNote.frontmatter.aliases),
		citekey: oldNote.citekey || fallbackStem,
		publication_date: pubDate || undefined,
		authors: oldNote.authors.length > 0 ? oldNote.authors : undefined,
		isOldFormat: true,
		frontmatter: oldNote.frontmatter,
	};
}
