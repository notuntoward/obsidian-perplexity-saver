// Bundles the one-time literature-note repair for Obsidian's developer console.
// Obsidian's module is not available there, so only its normalizePath is shimmed.
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

await esbuild.build({
	entryPoints: ["src/litNote/propertyRepair.ts"],
	bundle: true,
	format: "iife",
	globalName: "litNoteRepair",
	platform: "browser",
	target: "es2022",
	outfile: "build/repair-lit-notes.js",
	logLevel: "info",
	plugins: [{
		name: "obsidian-console-shim",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({
				path: fileURLToPath(new URL("./obsidian-console-shim.mjs", import.meta.url)),
			}));
		},
	}],
});
