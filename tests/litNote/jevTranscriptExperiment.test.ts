import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl, type App, type TFile, type RequestUrlResponse, type RequestUrlResponsePromise } from "obsidian";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { runJevTranscriptExperiment } from "../../src/litNote/jevTranscriptExperiment";

vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: vi.fn() }));
vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	getFrontMatterInfo: (content: string) => {
		const end = content.indexOf("\n---\n", 4);
		return content.startsWith("---\n") && end >= 0
			? { exists: true, frontmatter: content.slice(4, end), contentStart: end + 5 }
			: { exists: false, frontmatter: "", contentStart: 0 };
	},
	parseYaml: (text: string) => JSON.parse(text),
	requestUrl: vi.fn(),
}));

const file = { path: "note.md", basename: "note", extension: "md" } as TFile;
let body: string;
let frontmatter: Record<string, unknown>;
let app: App;

function responsePromise(response: RequestUrlResponse): RequestUrlResponsePromise {
	return Object.assign(Promise.resolve(response), {
		json: Promise.resolve(response.json),
		text: Promise.resolve(response.text),
		arrayBuffer: Promise.resolve(response.arrayBuffer),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	body = "# Transcript\n[0:00](https://youtu.be/example?t=0 \"0-5\") we finished the experiment we checked the results\n";
	frontmatter = { title: "Keep me" };
	const content = () => `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
	app = {
		vault: { cachedRead: vi.fn(async () => content()) },
		metadataCache: { getFileCache: () => ({
			frontmatter,
			headings: [{ heading: "Transcript", level: 1, position: { end: { offset: content().indexOf("# Transcript") + 12 } } }],
		}) },
		secretStorage: { getSecret: vi.fn(() => "test-key") },
		fileManager: { processFrontMatter: vi.fn(async (_file, fn) => { fn(frontmatter); }) },
	} as unknown as App;
	vi.mocked(askNoteDecision).mockResolvedValue("create");
	vi.mocked(requestUrl).mockImplementation((param) => {
		if (typeof param === "string") throw new Error("Expected structured request");
		const request = JSON.parse(String(param.body));
		return responsePromise({
			status: 200,
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
			json: {
				model: "jev-1.14.0",
				answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])),
				usage: { input_tokens: 100 },
			},
		});
	});
});

describe("Jev experiment note persistence and consent", () => {
	it("saves the results alongside the note without changing its transcript or unrelated properties", async () => {
		const original = body;
		await runJevTranscriptExperiment(app, file, "Transcript", "typesafe");
		expect(frontmatter.jev_transcript).toBeDefined();
		expect(frontmatter.title).toBe("Keep me");
		expect(body).toBe(original);
		expect(askNoteDecision).toHaveBeenCalledOnce();
		const param = vi.mocked(requestUrl).mock.calls[0][0];
		if (typeof param === "string") throw new Error("Expected structured request");
		const request = JSON.parse(String(param.body));
		expect(JSON.stringify(request)).not.toContain("Keep me");
		expect(JSON.stringify(frontmatter)).not.toContain("test-key");
	});

	it("reopens cached results offline without consulting credentials or asking for consent", async () => {
		await runJevTranscriptExperiment(app, file, "Transcript", "typesafe");
		vi.mocked(requestUrl).mockClear();
		vi.mocked(askNoteDecision).mockClear();
		vi.mocked(app.secretStorage.getSecret).mockImplementation(() => { throw new Error("Offline"); });
		const cached = await runJevTranscriptExperiment(app, file, "Transcript", "");
		expect(cached?.inputTokens).toBe(100);
		expect(requestUrl).not.toHaveBeenCalled();
		expect(askNoteDecision).not.toHaveBeenCalled();
	});

	it("does not call the API or modify the note when consent is cancelled", async () => {
		vi.mocked(askNoteDecision).mockResolvedValue("cancel");
		expect(await runJevTranscriptExperiment(app, file, "Transcript", "typesafe")).toBeNull();
		expect(requestUrl).not.toHaveBeenCalled();
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});

	it("rejects a body edit during a request, and reports HTTP failures instead of saving bogus results", async () => {
		const implementation = vi.mocked(requestUrl).getMockImplementation()!;
		vi.mocked(requestUrl).mockImplementation((param) => {
			const response = implementation(param);
			body += "\nEdited while running\n";
			return response;
		});
		await expect(runJevTranscriptExperiment(app, file, "Transcript", "typesafe")).rejects.toThrow("body changed");
		expect(frontmatter.jev_transcript).toBeUndefined();
		vi.mocked(requestUrl).mockReturnValue(responsePromise({ status: 429, json: {}, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) }));
		await expect(runJevTranscriptExperiment(app, file, "Transcript", "typesafe")).rejects.toThrow("HTTP 429");
	});
});
