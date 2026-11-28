import type { HeadlineMethod } from "./normalize/headlines";
import type { NameStyle } from "./litNote/bibtexName";
import type { CollectionAdoptions } from "./litNote/collectionAdoption";
import { DEFAULT_TRANSCRIPT_HEADING } from "commons/youtube";
import { DEFAULT_LIT_NOTES_FOLDER } from "./litNote/constants";

export interface PerplexitySaverSettings {
	searchesFolder: string;
	generatedTag: string;
	/**
	 * When on, the note body is post-processed to remove blank lines
	 * immediately before and after every heading and to collapse any run
	 * of 2+ blank lines to one. Produces a denser, more uniform file.
	 */
	collapseBlankLines: boolean;
	/**
	 * When on (the default), prompt callouts are rendered as collapsed
	 * by default (`> [!Prompt]-`). When off, they are rendered as
	 * expanded by default (`> [!Prompt]+`).
	 */
	collapsePromptCallouts: boolean;
	/**
	 * Algorithm for the summary heading above each user prompt in a saved
	 * note. "lead" uses the first sentence (fast, no deps); "tf-idf" ranks
	 * every sentence by TF-IDF with a lead-position prior and picks the
	 * best (requires the `stopword` package).
	 */
	headlineMethod: HeadlineMethod;
	/** Max length of the summary heading, including a possible ellipsis. */
	headlineMaxChars: number;
	/**
	 * Lead-position prior for the TF-IDF method. 0 disables it. The
	 * sentence in position i gets bonus `leadBias * (1 - i / N)`. Reasonable
	 * range: 0.05 to 0.35. Ignored when headlineMethod is "lead".
	 */
	headlineLeadBias: number;
	/**
	 * Automatically fetch webpage titles to build clean markdown links for sources.
	 */
	autoFetchSourceTitles: boolean;
	/**
	 * Maximum length of a fetched source link title.
	 */
	sourceTitleMaxChars: number;
	/**
	 * Local HTTP Port for Zotero API communication.
	 */
	zoteroPort: number;
	/**
	 * Literature notes folder path in vault (defaults to lit/lit_notes from refwrangle).
	 */
	litNotesFolder: string;
	/**
	 * Minimum title fuzzy match score (0-100) for matching sources to Zotero items.
	 */
	minTitleMatchScore: number;
	/**
	 * Automatically relink sources with Zotero and Obsidian literature notes when importing/syncing.
	 */
	autoRelinkSources: boolean;
	litNoteLastViewed: Record<string, number>;
	collectionAdoptions: CollectionAdoptions;
	/**
	 * When enabled, validates that author and creator names are in '<last_name>, <first_name>'
	 * format before creating literature notes from Zotero items.
	 */
	validateAuthorNameFormat: boolean;
	/**
	 * Format style for author names in literature notes ('last-first', 'bibtex', 'first-last', 'von-last', 'initials').
	 */
	authorFormatStyle: NameStyle;
	/**
	 * When enabled with 'last-first' style, drops 'von' particles (e.g. "Beethoven, Ludwig" instead of "van Beethoven, Ludwig").
	 */
	authorDropVon: boolean;
	/**
	 * When enabled, automatically downloads the timestamped transcript and inserts it
	 * under the transcript heading when creating literature notes from YouTube video references.
	 */
	downloadYoutubeTranscripts: boolean;
	/**
	 * Text of the level-1 heading that downloaded YouTube transcripts are stored
	 * under. Match this heading in Watchword when using a custom name.
	 */
	transcriptHeading: string;

}

export const DEFAULT_SETTINGS: PerplexitySaverSettings = {
	searchesFolder: "ai-searches",
	generatedTag: "ai-generated",
	collapseBlankLines: true,
	collapsePromptCallouts: true,
	headlineMethod: "lead",
	headlineMaxChars: 100,
	headlineLeadBias: 0.2,
	autoFetchSourceTitles: true,
	sourceTitleMaxChars: 100,
	zoteroPort: 23119,
	litNotesFolder: DEFAULT_LIT_NOTES_FOLDER,
	minTitleMatchScore: 95,
	autoRelinkSources: false,
	litNoteLastViewed: {},
	collectionAdoptions: {},
	validateAuthorNameFormat: false,
	authorFormatStyle: "last-first",
	authorDropVon: false,
	downloadYoutubeTranscripts: true,
	transcriptHeading: DEFAULT_TRANSCRIPT_HEADING,
};
