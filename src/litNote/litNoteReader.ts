import { parseYaml } from "obsidian";
import { buildAliases, cleanFieldValue, formatObsidianDate } from "./buildLitNote";

export interface LitNoteMetadata {
	title: string;
	aliases: string[];
	citekey: string;
	publication_date?: string;
	authors?: string[];
	frontmatter: Record<string, unknown>;
}

/**
 * Extract literature note metadata from parsed frontmatter.
 */
export function extractLitNoteMetadata(
	frontmatter: Record<string, unknown> | null | undefined,
	fallbackStem = ""
): LitNoteMetadata {
	const fm = frontmatter || {};
	const fmTitle = fm.title || fm.Title;
	const cleanTitle = fmTitle ? cleanFieldValue(String(fmTitle)) : "";
	const rawDate = fm.publication_date || fm.date;
	const pubDate = rawDate ? formatObsidianDate(rawDate) : undefined;
	const citekey = String(
		fm.citekey ||
		fm["citation key"] ||
		fm["citation_key"] ||
		fallbackStem
	).trim();

	const authors = Array.isArray(fm.authors)
		? fm.authors.map((a) => cleanFieldValue(String(a)))
		: undefined;

	return {
		title: cleanTitle || fallbackStem,
		aliases: buildAliases(cleanTitle || fallbackStem, fm.aliases),
		citekey: citekey || fallbackStem,
		publication_date: pubDate || undefined,
		authors,
		frontmatter: fm,
	};
}

/**
 * Canonical reader for literature notes.
 *
 * All vault notes use YAML frontmatter for metadata. The old Dataview
 * callout-body format is no longer used. See AGENTS.md for history.
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
			// Malformed frontmatter: return best-effort empty result
		}
	}

	return extractLitNoteMetadata(frontmatter, fallbackStem);
}
