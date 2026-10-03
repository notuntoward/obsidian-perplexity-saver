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

	const fmTitle = frontmatter.title || frontmatter.Title;
	const cleanTitle = fmTitle ? cleanFieldValue(String(fmTitle)) : "";
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
		frontmatter,
	};
}
