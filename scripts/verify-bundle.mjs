#!/usr/bin/env node
import fs from "fs";
import path from "path";

const BUNDLE_PATH = path.resolve(process.cwd(), "main.js");

if (!fs.existsSync(BUNDLE_PATH)) {
	console.error(`❌ main.js not found at ${BUNDLE_PATH}. Run 'npm run bundle' first.`);
	process.exit(1);
}

const stats = fs.statSync(BUNDLE_PATH);
const content = fs.readFileSync(BUNDLE_PATH, "utf8");

const bannerMatch = content.match(/Built at:\s*([^\r\n*]+)/);
const builtAtStr = bannerMatch ? bannerMatch[1].trim() : null;

console.log("--------------------------------------------------");
console.log(`📦 Bundle File:       main.js (${(stats.size / 1024).toFixed(1)} KB)`);
console.log(`🕒 File Last Modified: ${stats.mtime.toISOString()}`);
if (builtAtStr) {
	const buildDate = new Date(builtAtStr);
	const ageSec = Math.round((Date.now() - buildDate.getTime()) / 1000);
	console.log(`⏱️ Built At:          ${builtAtStr} (${ageSec}s ago)`);
} else {
	console.log("⏱️ Built At:          (No 'Built at:' banner found)");
}
console.log("--------------------------------------------------");

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
	console.log("ℹ️ No fingerprint query provided. Bundle verified present and readable.");
	process.exit(0);
}

const idx = content.indexOf(query);

if (idx !== -1) {
	const start = Math.max(0, idx - 50);
	const end = Math.min(content.length, idx + query.length + 50);
	const snippet = content.slice(start, end).replace(/\r?\n/g, " ");

	console.log(`✅ FINGERPRINT FOUND at byte offset ${idx}:`);
	console.log(`   ...${snippet}...`);
	console.log("--------------------------------------------------");
	process.exit(0);
} else {
	console.error(`❌ FINGERPRINT NOT FOUND: "${query}"`);
	console.error("\n💡 Hint: esbuild in production mode minifies identifiers (e.g., function & variable");
	console.error("   names become 1-2 letter tokens like 'Ia' or 'Rt').");
	console.error("   Try searching for a unique string literal, error message, or regex pattern instead.");
	console.log("--------------------------------------------------");
	process.exit(1);
}
