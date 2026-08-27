import { describe, it, expect, vi } from "vitest";
import { detectAndParse } from "../../src/parsers/detect";
import { buildNoteBody } from "../../src/normalize/buildNote";
import { createPerplexityNote } from "../../src/note-creator";
import { replaceDialogFromClipboard } from "../../src/commands/replace";
import { HeadlineOptions } from "../../src/normalize/headlines";

const HEADLINE_OPTIONS: HeadlineOptions = { method: "lead" };

const PERPLEXITY_CORPUS: Array<{ name: string; raw: string; expectedUrl: string; expectedMetadata: string }> = [
	{
		name: "Stock Perplexity with standard UUID search URL and PDT timestamp",
		raw: `[Perplexity](https://www.perplexity.ai/search/646278ed-2373-4211-adf3-2027de504cca) · *2026-08-27 13:11 PDT*
# The screenshot shows emacs running an ivy/swiper search.

The match was 'Interventions Subgroup analyses demonstrated that diet type moderated intervention effects for systolic blood'[1].

# Citations:
[1] [Interventions Study](https://example.com/study)`,
		expectedUrl: "https://www.perplexity.ai/search/646278ed-2373-4211-adf3-2027de504cca",
		expectedMetadata: "2026-08-27 13:11 PDT",
	},
	{
		name: "Bare domain without www prefix",
		raw: `[Perplexity](https://perplexity.ai/search/abc-123) · *2026-07-27 10:18 PDT*
# How do I configure foo mode?

Bar mode can be configured.[1]

# Citations:
[1] https://example.com/one`,
		expectedUrl: "https://perplexity.ai/search/abc-123",
		expectedMetadata: "2026-07-27 10:18 PDT",
	},
	{
		name: "Subdomain (labs.perplexity.ai) with query parameters",
		raw: `[Perplexity](https://labs.perplexity.ai/search/test-uuid?query=emacs&focus=internet) · *2026-08-01 09:00 UTC*
# Question about query params

Here is the answer.[1]

# Citations:
[1] [Link](https://example.com/test)`,
		expectedUrl: "https://labs.perplexity.ai/search/test-uuid?query=emacs&focus=internet",
		expectedMetadata: "2026-08-01 09:00 UTC",
	},
	{
		name: "Root URL without trailing slash",
		raw: `[Perplexity](https://www.perplexity.ai) · *2026-08-27*
# What is today?

Today is Thursday.`,
		expectedUrl: "https://www.perplexity.ai",
		expectedMetadata: "2026-08-27",
	},
	{
		name: "Single newline between metadata header and prompt heading",
		raw: `[Perplexity](https://www.perplexity.ai/search/single-newline-test) · *2026-08-27 12:00 EDT*
# Single newline prompt
This prompt had only one newline after header.[1]

# Citations:
[1] https://example.com`,
		expectedUrl: "https://www.perplexity.ai/search/single-newline-test",
		expectedMetadata: "2026-08-27 12:00 EDT",
	},
	{
		name: "Windows CRLF line endings throughout",
		raw: "[Perplexity](https://www.perplexity.ai/search/crlf-test) · *2026-08-27 12:00 PDT*\r\n# CRLF Prompt\r\n\r\nAnswer with CRLF.[1]\r\n\r\n# Citations:\r\n[1] https://example.com\r\n",
		expectedUrl: "https://www.perplexity.ai/search/crlf-test",
		expectedMetadata: "2026-08-27 12:00 PDT",
	},
	{
		name: "Multi-turn dialog with citations in multiple turns",
		raw: `[Perplexity](https://www.perplexity.ai/search/multiturn-789) · *2026-08-27 15:30 PDT*
# Turn 1 Question

Turn 1 Answer.[1]

# Citations:
[1] [One](https://example.com/1)
---
# Turn 2 Question

Turn 2 Answer.[1]

# Citations:
[1] [Two](https://example.com/2)`,
		expectedUrl: "https://www.perplexity.ai/search/multiturn-789",
		expectedMetadata: "2026-08-27 15:30 PDT",
	},
	{
		name: "Prompt containing <q> quote excerpts and fenced heading",
		raw: `[Perplexity](https://www.perplexity.ai/search/quote-test) · *2026-08-27 16:00 PDT*
# <q>quoted prior response</q> What about this?

Detailed explanation.[1]

# Citations:
[1] https://example.com/quote-ref`,
		expectedUrl: "https://www.perplexity.ai/search/quote-test",
		expectedMetadata: "2026-08-27 16:00 PDT",
	},
];

describe("Perplexity Metadata Preservation Invariants", () => {
	beforeEach(() => {
		Object.assign(navigator, {
			clipboard: {
				readText: vi.fn(),
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	it.each(PERPLEXITY_CORPUS)(
		"Parser invariant: $name extracts sourceUrl and sourceMetadata",
		({ raw, expectedUrl, expectedMetadata }) => {
			const dialog = detectAndParse(raw);
			expect(dialog.sourceVendor).toBe("perplexity");
			expect(dialog.sourceUrl).toBe(expectedUrl);
			expect(dialog.sourceMetadata).toBe(expectedMetadata);
		}
	);

	it.each(PERPLEXITY_CORPUS)(
		"Renderer invariant: $name renders [Perplexity](url) · *timestamp* at line 1",
		({ raw, expectedUrl, expectedMetadata }) => {
			const dialog = detectAndParse(raw);
			const { body } = buildNoteBody(dialog);

			const firstLine = body.split("\n")[0].trim();
			expect(firstLine).toBe(`[Perplexity](${expectedUrl}) · *${expectedMetadata}*`);

			const secondSection = body.split("\n\n")[1]?.trim();
			expect(secondSection).toBe("# Dialog");
		}
	);

	it.each(PERPLEXITY_CORPUS)(
		"Note Creator invariant: $name writes frontmatter and header in new note",
		async ({ raw, expectedUrl }) => {
			const mockApp: any = {
				vault: {
					getAbstractFileByPath: vi.fn().mockReturnValue(null),
					createFolder: vi.fn().mockResolvedValue(undefined),
					create: vi.fn().mockImplementation((path, content) => ({ path, content })),
				},
				fileManager: {
					processFrontMatter: vi.fn().mockImplementation(async (_file, cb) => {
						const fm: Record<string, unknown> = {};
						await cb(fm);
						return fm;
					}),
					generateMarkdownLink: vi.fn().mockReturnValue("[[link]]"),
				},
			};

			let capturedFrontmatter: Record<string, unknown> = {};
			mockApp.fileManager.processFrontMatter = vi.fn().mockImplementation(async (_file, cb) => {
				await cb(capturedFrontmatter);
			});

			const result = await createPerplexityNote({
				app: mockApp,
				activeFile: { parent: { path: "parent" } } as any,
				clipboardContent: raw,
				filename: "test-note",
				searchesFolder: "ai-searches",
				generatedTag: "ai-generated",
				collapseBlankLines: true,
				collapsePromptCallouts: true,
				headlineOptions: HEADLINE_OPTIONS,
				autoFetchSourceTitles: false,
			});

			expect(result.success).toBe(true);
			expect(capturedFrontmatter["ai-source-url"]).toBe(expectedUrl);
			expect(capturedFrontmatter["ai-source-vendor"]).toBe("perplexity");

			const createdBody = mockApp.vault.create.mock.calls[0][1] as string;
			expect(createdBody).toContain(`[Perplexity](${expectedUrl})`);
		}
	);

	it.each(PERPLEXITY_CORPUS)(
		"Replace Command invariant: $name updates frontmatter and header in replaced note",
		async ({ raw, expectedUrl }) => {
			let capturedFrontmatter: Record<string, unknown> = {};
			const mockApp: any = {
				vault: {
					read: vi.fn().mockResolvedValue("# Existing note"),
					modify: vi.fn().mockResolvedValue(undefined),
				},
				metadataCache: {
					getFileCache: vi.fn().mockReturnValue({}),
				},
				fileManager: {
					processFrontMatter: vi.fn().mockImplementation(async (_file, cb) => {
						await cb(capturedFrontmatter);
					}),
				},
			};

			(navigator.clipboard.readText as any).mockResolvedValue(raw);

			const result = await replaceDialogFromClipboard(
				mockApp,
				{ path: "note.md", basename: "note" } as any,
				HEADLINE_OPTIONS,
				false
			);

			expect(result.success).toBe(true);
			expect(capturedFrontmatter["ai-source-url"]).toBe(expectedUrl);
			expect(capturedFrontmatter["ai-source-vendor"]).toBe("perplexity");

			const modifiedBody = mockApp.vault.modify.mock.calls[0][1] as string;
			expect(modifiedBody).toContain(`[Perplexity](${expectedUrl})`);
		}
	);
});
