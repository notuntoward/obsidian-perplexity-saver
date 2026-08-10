import { App } from "obsidian";
import { ZoteroClient } from "./zoteroClient";

/**
 * Settings that control automatic Zotero / literature-note relinking.
 * Mirrors the subset of PerplexitySaverSettings the relinker consumes so
 * command and note-creation paths can pass them without reaching into the
 * plugin object.
 */
export interface AutoRelinkSettings {
	/**
	 * When on, sources in newly created or newly synced notes are matched
	 * against the local Zotero library and vault literature notes.
	 */
	autoRelinkSources: boolean;
	/**
	 * Local HTTP port for Zotero 7 API communication.
	 */
	zoteroPort: number;
	/**
	 * Literature notes folder path in vault (defaults to lit/lit_notes).
	 */
	litNotesFolder: string;
	/**
	 * Minimum title fuzzy match score (0-100) for matching sources to Zotero items.
	 */
	minTitleMatchScore: number;
}

/**
 * Run Zotero / literature-note relinking on `noteText` when the auto-relink
 * setting is enabled, otherwise return the text untouched. Relinking is
 * best-effort: the relinker itself catches connection and matching errors,
 * surfaces a Notice, and returns the original text so the caller's main
 * workflow (import or sync) is never blocked by a missing or unreachable
 * Zotero instance.
 */
export async function maybeAutoRelinkSources(
	app: App,
	noteText: string,
	settings: AutoRelinkSettings,
	zoteroClient?: ZoteroClient
): Promise<string> {
	if (!settings.autoRelinkSources) {
		return noteText;
	}
	const { autoRelinkSourcesInNote } = await import("./relinker");
	return autoRelinkSourcesInNote(app, noteText, settings, zoteroClient);
}
