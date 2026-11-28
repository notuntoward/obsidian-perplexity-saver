/**
 * One-time literature-note property repair, loaded from Obsidian's developer console.
 * It is not part of the plugin bundle; build it with `npm run bundle:repair`.
 */
import type { App, PluginManifest } from "obsidian";
import { DEFAULT_LIT_NOTES_FOLDER } from "./constants";
import { hasLiteratureNoteCategory, isDirectChildOfFolder } from "commons/litnote";
import {
	isEmptyValue,
	LIT_NOTE_STATUS_DEFAULTS,
	normalizeDataviewKey,
	normalizePropertyList,
	OLD_INDICATOR_TAG,
} from "./propertyUtils";

const SAVER_PLUGIN_ID = "perplexity-saver";
const LIST_PROPERTIES = [
	["zotero_tags", [OLD_INDICATOR_TAG]],
	["zotero_collections", []],
] as const;
const RETIRED_STATUS_KEYS = new Set(["status", "dateread"]);
const STATUS_KEYS = Object.keys(LIT_NOTE_STATUS_DEFAULTS) as Array<keyof typeof LIT_NOTE_STATUS_DEFAULTS>;

type Entries = Array<[string, unknown]>;

/** Split a list property, including old stringified lists such as "['a b', 'c']". */
export function parsePropertyList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(parsePropertyList);
	if (typeof value === "number" || typeof value === "boolean") return [String(value)];
	if (typeof value !== "string") return [];
	const text = value.trim();
	if (!(text.startsWith("[") && text.endsWith("]"))) return [text];
	return [...text.slice(1, -1).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,\s'"][^,]*)/g)].map((match) =>
		(match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, "$1").trim()
	);
}

function placeAfter(entries: Entries, anchor: string, keys: readonly string[]): Entries {
	const moved = keys.flatMap((key) => entries.filter(([name]) => name === key));
	const rest = entries.filter(([name]) => !keys.includes(name));
	rest.splice(rest.findIndex(([name]) => name === anchor) + 1, 0, ...moved);
	return rest;
}

/**
 * Repair one literature note's frontmatter in place and return short change labels.
 * Safe to run repeatedly: an already repaired note is left unchanged.
 */
export function repairLitNoteFrontmatter(
	frontmatter: Record<string, unknown>,
	options: { hasBacklinks: boolean }
): string[] {
	const changes: string[] = [];
	let entries: Entries = Object.entries(frontmatter);
	const original = JSON.stringify(entries);
	const has = (key: string) => entries.some(([name]) => name === key);
	const get = (key: string) => entries.find(([name]) => name === key)?.[1];
	const set = (key: string, value: unknown) => {
		if (has(key)) entries = entries.map(([name, old]) => [name, name === key ? value : old]);
		else entries.push([key, value]);
	};

	if (!has("tags")) {
		entries.push(["tags", []]);
		changes.push("added empty tags");
	}

	for (const [property, exclude] of LIST_PROPERTIES) {
		const legacy = normalizeDataviewKey(property);
		const keys = entries.map(([name]) => name).filter((name) => normalizeDataviewKey(name) === legacy);
		if (!keys.length) {
			entries.push([property, []]);
			changes.push(`added empty ${property}`);
			continue;
		}
		const values = normalizePropertyList(keys.flatMap((key) => parsePropertyList(get(key))), exclude);
		const at = entries.findIndex(([name]) => keys.includes(name));
		const before = JSON.stringify(keys.map((key) => [key, get(key)]));
		entries = entries.filter(([name]) => !keys.includes(name));
		entries.splice(at, 0, [property, values]);
		if (keys.some((key) => key !== property)) changes.push(`renamed ${keys.filter((key) => key !== property).join(", ")} to ${property}`);
		if (before !== JSON.stringify([[property, values]])) changes.push(`repaired ${property}`);
	}

	const retired = entries.filter(([name]) => RETIRED_STATUS_KEYS.has(normalizeDataviewKey(name)));
	if (retired.length) {
		entries = entries.filter((entry) => !retired.includes(entry));
		changes.push("removed status/dateread");
	}
	const wasRead = retired.some(([name, value]) => normalizeDataviewKey(name) === "dateread" && !isEmptyValue(value));

	for (const key of STATUS_KEYS) {
		const current = get(key);
		if (current === "true" || current === "false") set(key, current === "true");
		else if (!has(key)) {
			set(key, LIT_NOTE_STATUS_DEFAULTS[key]);
			changes.push(`added ${key}`);
		}
	}
	if (wasRead && get("read") !== true) {
		set("read", true);
		changes.push("set read from dateread");
	}
	if (options.hasBacklinks && get("linked") !== true) {
		set("linked", true);
		changes.push("set linked from backlinks");
	}

	entries = placeAfter(placeAfter(entries, "category", ["tags"]), "tags", STATUS_KEYS);
	if (JSON.stringify(entries) === original) return [];
	if (!changes.length) changes.push("reordered properties");
	for (const key of Object.keys(frontmatter)) delete frontmatter[key];
	Object.assign(frontmatter, Object.fromEntries(entries));
	return changes;
}

export interface LitNoteRepairReport {
	mode: "dry run" | "applied";
	litNotesFolder: string;
	notesChecked: number;
	notesChanged: number;
	changeCounts: Record<string, number>;
	examples: Record<string, string[]>;
	errors: string[];
}

/**
 * Repair every literature note directly inside Saver's literature-notes folder.
 * Dry run by default; `{ apply: true }` writes changes through Obsidian's frontmatter API.
 */
export async function runLitNoteRepair(
	app: App,
	options: { apply?: boolean; litNotesFolder?: string } = {}
): Promise<LitNoteRepairReport> {
	const apply = options.apply === true;
	const adapter = app.vault.adapter;
	const plugins = (app as App & { plugins?: { manifests?: Record<string, PluginManifest>; enabledPlugins?: Set<string> } }).plugins;
	const directory = plugins?.manifests?.[SAVER_PLUGIN_ID]?.dir;
	if (!directory) throw new Error("Saver's registered installation directory is unavailable; repair stopped.");
	const settingsPath = `${directory}/data.json`;
	if (!(await adapter.exists(settingsPath))) throw new Error(`Saver settings are missing at ${settingsPath}; repair stopped.`);
	const settingsText = await adapter.read(settingsPath);
	const settings = JSON.parse(settingsText) as Record<string, unknown>;
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("Saver settings must be an object; repair stopped.");
	}
	const litNotesFolder = options.litNotesFolder ??
		(typeof settings.litNotesFolder === "string"
			? settings.litNotesFolder
			: DEFAULT_LIT_NOTES_FOLDER);
	if (typeof litNotesFolder !== "string" || !litNotesFolder.trim()) {
		throw new Error("Saver's literature notes folder is unknown; pass { litNotesFolder: \"...\" }.");
	}
	const linkedTargets = new Set<string>();
	for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
		for (const target of Object.keys(targets)) if (target !== source) linkedTargets.add(target);
	}

	const report: LitNoteRepairReport = {
		mode: apply ? "applied" : "dry run",
		litNotesFolder,
		notesChecked: 0,
		notesChanged: 0,
		changeCounts: {},
		examples: {},
		errors: [],
	};
	for (const file of app.vault.getMarkdownFiles()) {
		if (!isDirectChildOfFolder(file, litNotesFolder)) continue;
		const cached = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!cached || !(hasLiteratureNoteCategory(cached) || cached.zotero_item_key || cached.citekey)) continue;
		report.notesChecked++;
		const repairOptions = { hasBacklinks: linkedTargets.has(file.path) };
		let changes: string[] = [];
		try {
			if (apply) {
				await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
					changes = repairLitNoteFrontmatter(frontmatter, repairOptions);
				});
			} else {
				changes = repairLitNoteFrontmatter(structuredClone(cached), repairOptions);
			}
		} catch (error) {
			report.errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!changes.length) continue;
		report.notesChanged++;
		for (const change of changes) {
			report.changeCounts[change] = (report.changeCounts[change] ?? 0) + 1;
			const examples = (report.examples[change] ??= []);
			if (examples.length < 3) examples.push(file.path);
		}
	}

	return report;
}
