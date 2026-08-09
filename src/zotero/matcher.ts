import { App, normalizePath } from "obsidian";

/**
 * Extract main title by stripping subtitles/authors beyond delimiters (|, :, --, . ).
 * Ported from refwrangle.py extract_main_title.
 */
export function extractMainTitle(fullTitle: string): string {
	if (!fullTitle) return "";
	let trimmed = fullTitle.trim();
	// Strip arXiv ID bracket prefixes like [1805.09785] or [math.NT/0203001]
	trimmed = trimmed.replace(/^\[(?:\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]+)?\/\d{7})(?:v\d+)?\]\s*/i, "");
	// Split by |, :, --, or period followed by a space and capital letter
	const delimiters = /\||:|--|\.(?=\s[A-Z])/;
	const parts = trimmed.split(delimiters);
	return parts[0].trim();
}

/**
 * Lowercases, removes stop words, and strips non-alphanumeric characters.
 * Ported from refwrangle.py normalize_string.
 */
export function normalizeString(str: string): string {
	if (!str) return "";
	// Strip arXiv ID bracket prefixes like [1805.09785]
	const cleanedStr = str.replace(/^\[(?:\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]+)?\/\d{7})(?:v\d+)?\]\s*/i, "");
	const commonWords = new Set([
		"the",
		"a",
		"an",
		"and",
		"or",
		"but",
		"in",
		"on",
		"at",
		"to",
		"for",
		"of",
		"with",
		"by",
	]);
	const cleaned = cleanedStr
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.split(/\s+/)
		.filter((word) => word && !commonWords.has(word));

	return cleaned.join(" ");
}

/**
 * Compute similarity score (0 to 100) between two titles.
 * Ported from refwrangle.py match_titles.
 */
export function matchTitles(
	title1: string,
	title2: string,
	options: { mainTitleOnly?: boolean; normalize?: boolean } = {}
): number {
	const mainTitleOnly = options.mainTitleOnly ?? true;
	const normalize = options.normalize ?? true;

	let t1 = title1;
	let t2 = title2;

	if (mainTitleOnly) {
		t1 = extractMainTitle(t1);
		t2 = extractMainTitle(t2);
	}

	if (normalize) {
		t1 = normalizeString(t1);
		t2 = normalizeString(t2);
	}

	if (!t1 || !t2) return 0;
	if (t1 === t2) return 100;

	// Calculate token set ratio and partial ratio
	const words1 = t1.split(/\s+/);
	const words2 = t2.split(/\s+/);

	const set1 = new Set(words1);
	const set2 = new Set(words2);

	let intersection = 0;
	set1.forEach((word) => {
		if (set2.has(word)) intersection++;
	});

	const tokenRatio = (2 * intersection) / (set1.size + set2.size);

	// Partial sequence match (is smaller string contained in larger)
	const shorter = t1.length <= t2.length ? t1 : t2;
	const longer = t1.length <= t2.length ? t2 : t1;
	const isSub = longer.includes(shorter);
	const partialRatio = isSub ? shorter.length / longer.length : 0;

	// Combine scores out of 100
	const finalScore = Math.max(tokenRatio * 100, (tokenRatio * 0.7 + partialRatio * 0.3) * 100);
	return Math.round(finalScore);
}

/**
 * Check whether an Obsidian Literature Note exists for a given citekey.
 * Returns the matching Markdown file basename/stem if found, or null if not found.
 */
export function findLitNoteForCitekey(
	app: App,
	citekey: string,
	litNotesFolder?: string
): string | null {
	if (!citekey || !app || !app.vault) return null;

	const targetStem = citekey.toLowerCase().trim();
	const files = app.vault.getMarkdownFiles();

	let normalizedFolder = "";
	if (litNotesFolder && litNotesFolder.trim()) {
		normalizedFolder = normalizePath(litNotesFolder.trim()).toLowerCase();
		while (normalizedFolder.endsWith("/")) {
			normalizedFolder = normalizedFolder.slice(0, -1);
		}
	}

	// 1. Primary check inside litNotesFolder
	for (const file of files) {
		const stem = file.basename.toLowerCase().trim();
		const isMatch =
			stem === targetStem || stem.startsWith(targetStem + " ") || stem.startsWith(targetStem + "-");
		if (isMatch) {
			if (normalizedFolder) {
				const parentPath = normalizePath(file.parent?.path || "").toLowerCase();
				if (parentPath === normalizedFolder || parentPath.startsWith(normalizedFolder + "/")) {
					return file.basename;
				}
			} else {
				return file.basename;
			}
		}
	}

	// 2. Secondary check across whole vault
	for (const file of files) {
		const stem = file.basename.toLowerCase().trim();
		const isMatch =
			stem === targetStem || stem.startsWith(targetStem + " ") || stem.startsWith(targetStem + "-");
		if (isMatch) {
			return file.basename;
		}
	}

	return null;
}
