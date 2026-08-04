/**
 * Shared types for the vendor-specific parsers. Every parser's only job is
 * to take a vendor's raw exported text and return a DialogFile matching
 * this schema. The renderer in src/normalize/ consumes only this shape,
 * never anything vendor-specific, so adding a new vendor only requires
 * writing one new parser file.
 */

/**
 * Vendor-neutral role names used everywhere in the plugin's internal
 * representation. Vendor-specific words ("user", "assistant", "human",
 * "model") are mapped to one of these at the parser boundary and never
 * leak into the rendered note or the block IDs.
 */
export type NoteRole = "prompt" | "ai";

/** A single citation extracted from an AI turn's body or its source list. */
export interface ParsedCitation {
	/** Citation number as it appeared in the raw text, e.g. "3". */
	origNum: string;
	url: string;
	/** Optional human-readable title for the linked source. */
	title?: string;
}

/** A single turn in the dialog. */
export interface DialogTurn {
	role: NoteRole;
	/**
	 * The turn's content, exactly as extracted from the source, BEFORE
	 * any heading-demotion is applied. The renderer demotes AI-turn
	 * content during rendering.
	 */
	rawText: string;
	/**
	 * Citations belonging to this specific turn (resolved to a URL, with
	 * the vendor's original numbering preserved as origNum). User turns
	 * have no citations.
	 */
	citations: ParsedCitation[];
}

/** A complete dialog, ready for the renderer. */
export interface DialogFile {
	sourceVendor: "perplexity" | "gemini";
	/** The URL from the clipboard metadata line linking back to the original AI dialog. */
	sourceUrl?: string;
	/** Original metadata string containing timestamp and timezone. */
	sourceMetadata?: string;
	turns: DialogTurn[];
}
