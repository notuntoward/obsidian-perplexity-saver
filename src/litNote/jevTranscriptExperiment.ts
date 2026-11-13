import { getFrontMatterInfo, Notice, parseYaml, requestUrl, type App, type TFile } from "obsidian";
import { askNoteDecision } from "./decisionModal";
import { loadTranscriptLines } from "./transcriptView";
import {
	classifyTranscript, createJevCache, jevCacheComplete, JEV_CACHE_KEY, JEV_MODEL,
	prepareTranscript, readJevCache, type JevCache,
} from "./jevTranscript";

const running = new WeakMap<App, Set<TFile>>();

export async function runJevTranscriptExperiment(
	app: App,
	file: TFile,
	heading: string,
	secretId: string,
	signal?: AbortSignal
): Promise<JevCache | null> {
	const assertActive = (): void => {
		if (signal?.aborted) throw new Error("Jev experiment cancelled. Saved batches can be resumed.");
	};
	const files = running.get(app) ?? new Set<TFile>();
	if (files.has(file)) throw new Error("Jev classification is already running for this note.");
	running.set(app, files);
	files.add(file);
	try {
		const content = await app.vault.cachedRead(file);
		const info = getFrontMatterInfo(content);
		const body = content.slice(info.contentStart);
		const frontmatter: unknown = info.exists ? parseYaml(info.frontmatter) : {};
		const raw: unknown = typeof frontmatter === "object" && frontmatter !== null
			? (frontmatter as Record<string, unknown>)[JEV_CACHE_KEY] : undefined;
		const lines = await loadTranscriptLines(app, file, heading);
		if (!lines?.length) throw new Error("This note has no timestamped transcript.");
		const transcript = prepareTranscript(lines);
		if (transcript.words.length < 2) throw new Error("Jev requires at least two whitespace-separated transcript words.");
		const cached = readJevCache(raw, transcript);
		if (cached && jevCacheComplete(cached)) {
			new Notice("Jev results already saved. Compare them offline; no API request was made.");
			return cached;
		}
		const apiKey = secretId ? app.secretStorage.getSecret(secretId) : null;
		if (!apiKey) throw new Error("Select a TypeSafe API key in the Jev experiment settings first.");
		const cache = cached ?? createJevCache(transcript);
		const remaining = cache.sentence.filter((p, i) => p === null || cache.paragraph[i] === null).length;
		const consent = await askNoteDecision(app, "Classify transcript with Jev?",
			`Send this note's transcript words and available caption gaps to TypeSafe AI (${JEV_MODEL})?\n\n${remaining} remaining word boundaries; two probability questions per boundary. This costs money. No other note text, metadata, or audio is sent. Each completed batch is saved in this note's jev_transcript frontmatter property for offline use and resumable retries.\n\nExisting or edited source captions are never replaced. Cancel to make no request.`,
			[{ label: "Classify and save", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (consent !== "create") return null;
		assertActive();
		new Notice("Jev classification started. Completed batches will be saved in the note.");
		const result = await classifyTranscript(transcript, cache, async (request) => {
			assertActive();
			const response = await requestUrl({
				url: "https://api.typesafe.ai/v1/systemone",
				method: "POST",
				contentType: "application/json",
				headers: { Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(request),
				throw: false,
			});
			if (response.status !== 200) throw new Error(`Jev API returned HTTP ${response.status}. Run again to resume saved batches.`);
			return response.json;
		}, async (progress) => {
			assertActive();
			const current = await app.vault.cachedRead(file);
			if (current.slice(getFrontMatterInfo(current).contentStart) !== body) {
				throw new Error("The note body changed during Jev classification. Results were not applied to edited text.");
			}
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[JEV_CACHE_KEY] = { ...progress, sentence: [...progress.sentence], paragraph: [...progress.paragraph] };
			});
		});
		new Notice(`Jev results saved: ${result.sentence.length} boundaries, ${result.inputTokens} input tokens (about $${(result.inputTokens * 0.042 / 1000000).toFixed(4)} at the advertised rate). Compare sentences and paragraphs offline.`);
		return result;
	} finally {
		files.delete(file);
	}
}
