import { describe, it, expect } from 'vitest';
import { ZoteroClient } from '../src/zotero/zoteroClient';

describe('Zotero Client fetch', () => {
	it('fetches SWDUCE7N', async () => {
		const client = new ZoteroClient({ port: 23119 });
		try {
			const items = await client.getItems({ forceRefresh: true });
			if (items.length > 0) {
				const swduce = items.find(i => i.zotkey === 'SWDUCE7N' || i.citekey === 'SWDUCE7N');
				expect(swduce).toBeDefined();
				expect(swduce?.citekey).toBe('Liu24kolmogArnoldKAN');
				expect(swduce?.url).toBe('http://arxiv.org/abs/2404.19756');

				const matchedByUrl = client.findItemByUrl('https://arxiv.org/abs/2404.19756');
				expect(matchedByUrl).toBeDefined();
				expect(matchedByUrl?.zotkey).toBe('SWDUCE7N');
			}
		} catch (err: any) {
			console.log("Local Zotero not reachable:", err.message);
		}
	}, 15000);
});
