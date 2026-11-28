// Mirrors Obsidian's normalizePath for the console-loaded literature-note repair.
export function normalizePath(path) {
	const normalized = path
		.replace(/[\\/]+/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\u00A0|\u202F/g, " ")
		.normalize("NFC");
	return normalized || "/";
}

// Referenced by commons helpers that the repair never calls.
export class TFile {}
