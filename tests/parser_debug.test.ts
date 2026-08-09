import { parseSourceLine, renderSourceLine } from '../src/zotero/sourceLinkState';
import { describe, it, expect } from 'vitest';

describe('parser test', () => {
	it('parses correctly', () => {
		const line = "[^1_1]: **[KAN: Kolmogorov–Arnold Networks -> SWDUCE7N](zotero://select/library/items/SWDUCE7N)**";
		const parsed = parseSourceLine(line);
		console.log(parsed);
	});
});
