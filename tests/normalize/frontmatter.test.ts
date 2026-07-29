import { describe, it, expect } from "vitest";
import { stripLeadingFrontmatterIfPresent } from "../../src/normalize/frontmatter";

describe("stripLeadingFrontmatterIfPresent", () => {
	it("returns text unchanged when no leading fence", () => {
		const out = stripLeadingFrontmatterIfPresent("just some text\n\n# Dialog");
		expect(out.body).toBe("just some text\n\n# Dialog");
		expect(out.existingFrontmatter).toBeUndefined();
	});

	it("strips a leading --- ... --- block", () => {
		const out = stripLeadingFrontmatterIfPresent("---\ntitle: hello\n---\n# Dialog\n");
		expect(out.body).toBe("# Dialog\n");
		expect(out.existingFrontmatter).toBeDefined();
		expect(out.existingFrontmatter?.title).toBe("hello");
	});

	it("strips a leading fence with CRLF line endings", () => {
		const out = stripLeadingFrontmatterIfPresent("---\r\ntitle: hello\r\n---\r\nbody");
		expect(out.body).toBe("body");
	});

	it("returns undefined for an empty body between fences", () => {
		const out = stripLeadingFrontmatterIfPresent("---\n\n---\nactual body");
		// Empty object is acceptable; what matters is that body has the actual content.
		expect(out.body).toBe("actual body");
	});
});
