import { describe, it, expect } from "vitest";
import { headlineFromLead, headlineFromText, headlineForPrompt } from "../../src/normalize/headlines";

describe("headlineFromLead (Method 1)", () => {
	it("returns the first sentence when it fits under the limit", () => {
		const text = "This is the first sentence. This is the second sentence that is longer.";
		// Both sentences fit under 50 chars combined, so the lead method
		// returns them concatenated.
		const headline = headlineFromLead(text, { maxChars: 50 });
		expect(headline).toBe("This is the first sentence.");
	});

	it("combines sentences until adding another would exceed the limit", () => {
		const text = "Short. Another short one. A third sentence here.";
		// "Short." (6 chars) fits in maxChars=10. "Short. Another short one."
		// is 25 chars, exceeds 10. So only the first sentence is included.
		const headline = headlineFromLead(text, { maxChars: 10 });
		expect(headline).toBe("Short.");
	});

	it("truncates cleanly at a word boundary with an ellipsis when the first sentence is too long", () => {
		const text =
			"This is an extremely long first sentence that definitely exceeds the maximum character limit we have set for headlines.";
		const headline = headlineFromLead(text, { maxChars: 30 });
		expect(headline.length).toBeLessThanOrEqual(30);
		// Ellipsis is the single Unicode character (…). Accept either form.
		expect(headline).toMatch(/(\.\.\.|…)$/);
	});

	it("strips markdown formatting before extracting sentences", () => {
		const text =
			"# My Header\n\n**Bold sentence** with [a link](https://example.com/) and `code`.";
		const headline = headlineFromLead(text, { maxChars: 100 });
		expect(headline).not.toContain("#");
		expect(headline).not.toContain("**");
		expect(headline).not.toContain("`");
		expect(headline).not.toContain("](https://");
		expect(headline).toContain("Bold sentence");
	});

	it("returns the first sentence for input where every sentence is a single word", () => {
		// With the lead method (no 3-word filter), single-word sentences are
		// valid candidates. "x." (2 chars) fits in maxChars=2; adding
		// "y." would push past the limit.
		const headline = headlineFromLead("x. y. z.", { maxChars: 2 });
		expect(headline).toBe("x.");
	});
});

describe("headlineFromText (Method 2: TF-IDF)", () => {
	it("returns a grammatically intact original sentence", () => {
		const text = [
			"Baseball has deep historical roots in the English language.",
			"The game evolved from earlier bat and ball activities played in England.",
			"Modern baseball is popular in North America and Japan.",
		].join("\n");
		const headline = headlineFromText(text, { maxChars: 80, leadBias: 0.0 });
		// The returned headline is one of the original sentences, not a
		// rephrased summary or a stop-word-stripped keyword bag.
		expect([
			"Baseball has deep historical roots in the English language.",
			"The game evolved from earlier bat and ball activities played in England.",
			"Modern baseball is popular in North America and Japan.",
		]).toContain(headline);
	});

	it("scores by term salience: a distinctive sentence wins over a generic one", () => {
		// First sentence is generic boilerplate; the second is the distinctive one.
		const text = [
			"This is some information about the topic.",
			"Baseball is the national pastime of the United States since the 19th century.",
		].join("\n");
		const headline = headlineFromText(text, { maxChars: 100, leadBias: 0.0 });
		expect(headline).toContain("Baseball");
	});

	it("leadBias favors the first sentence when scores are close", () => {
		const text = ["First sentence about cats.", "Second sentence about cats."].join("\n");
		const headline = headlineFromText(text, { maxChars: 100, leadBias: 0.5 });
		expect(headline).toBe("First sentence about cats.");
	});

	it("leadBias=0 lets the best-scoring sentence win regardless of position", () => {
		const text = [
			"First sentence about cats.",
			"Second sentence about baseball baseball baseball.",
		].join("\n");
		const headline = headlineFromText(text, { maxChars: 100, leadBias: 0.0 });
		expect(headline).toContain("baseball");
	});

	it("truncates cleanly at a word boundary with an ellipsis when too long", () => {
		const text = "This is a very very very very very long sentence that will need truncation.";
		const headline = headlineFromText(text, { maxChars: 30 });
		expect(headline.length).toBeLessThanOrEqual(30);
		// Ellipsis is the single Unicode character (…). Accept either form.
		expect(headline).toMatch(/(\.\.\.|…)$/);
	});

	it("returns the (possibly truncated) sentence for a single-sentence input", () => {
		const text = "Just one sentence here.";
		const headline = headlineFromText(text, { maxChars: 100 });
		expect(headline).toBe("Just one sentence here.");
	});
});

describe("headlineForPrompt (dispatch)", () => {
	it("dispatches to Method 1 (lead) by default when method=lead", () => {
		const headline = headlineForPrompt("First sentence here. Second sentence here.", {
			method: "lead",
			maxChars: 50,
		});
		// Both sentences fit under 50 chars so the lead method combines them.
		expect(headline).toBe("First sentence here. Second sentence here.");
	});

	it("dispatches to Method 2 (tf-idf) when method=tf-idf", () => {
		const headline = headlineForPrompt(
			["Some generic boilerplate.", "Baseball history in the United States."].join("\n"),
			{ method: "tf-idf", maxChars: 100 }
		);
		expect(headline).toContain("Baseball");
	});
});
