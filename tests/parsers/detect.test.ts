import { describe, it, expect } from "vitest";
import { detectAndParse } from "../../src/parsers/detect";

describe("detectAndParse", () => {
	it("routes gemini content to the gemini parser", () => {
		const dialog = detectAndParse(
			"**You**\n\nhello\n\n---\n\n**Gemini**\n\nworld\n"
		);
		expect(dialog.sourceVendor).toBe("gemini");
	});

	it("routes perplexity content to the perplexity parser", () => {
		const dialog = detectAndParse(
			"[Perplexity](https://www.perplexity.ai/search/x) hello"
		);
		expect(dialog.sourceVendor).toBe("perplexity");
	});

	it("defaults to perplexity for unrecognized content", () => {
		const dialog = detectAndParse("just some plain text");
		expect(dialog.sourceVendor).toBe("perplexity");
	});

	it("routes Save My Chatbot content to the perplexity parser", () => {
		const dialog = detectAndParse("**You**\n\nq\n\n**AI answer**\n\na");
		expect(dialog.sourceVendor).toBe("perplexity");
	});

	it("prefers perplexity when SMC markers + gemini URL are present", () => {
		const dialog = detectAndParse(
			"[Gemini](https://gemini.google.com/app/x) **You**\n\nq\n\n**AI answer**\n\na"
		);
		expect(dialog.sourceVendor).toBe("perplexity");
	});
});
