export const TRANSCRIPT_LANGUAGE_PREFIX = "<!-- saver-transcript-language:";

export function normalizeTranscriptLanguage(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const language = Intl.getCanonicalLocales(value.trim())[0];
		return language === "und" ? undefined : language;
	} catch (error: unknown) {
		if (error instanceof RangeError) return undefined;
		throw error;
	}
}

export function resolveTranscriptLanguage(values: readonly unknown[]): string | undefined {
	const languages = new Set(values.map(normalizeTranscriptLanguage));
	return languages.size === 1 ? languages.values().next().value : undefined;
}

export function isEnglishTranscript(language: string | undefined): boolean {
	return language?.split("-")[0] === "en";
}

/** Keep track metadata beside the transcript, not the video's original language. */
export function withTranscriptLanguage(section: string, value: unknown): string {
	const language = normalizeTranscriptLanguage(value);
	if (!language) return section;
	const newline = section.includes("\r\n") ? "\r\n" : "\n";
	const body = section.replace(/^[ \t]*<!-- saver-transcript-language:[^\r\n]*(?:\r?\n|$)/gm, "");
	const leading = body.match(/^(?:\r?\n)*/)?.[0] ?? "";
	return `${leading}${TRANSCRIPT_LANGUAGE_PREFIX} ${language} -->${newline}${body.slice(leading.length)}`;
}
