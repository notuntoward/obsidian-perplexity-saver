import { describe, it } from 'vitest';
import { ZoteroClient } from '../src/zotero/zoteroClient';

describe('Zotero Client fetch', () => {
	it('fetches SWDUCE7N', async () => {
		const client = new ZoteroClient({ port: 23119 });
		const items = await client.getItems({ forceRefresh: true });
		const swduce = items.find(i => i.zotkey === 'SWDUCE7N' || i.citekey === 'SWDUCE7N');
		console.log("SWDUCE7N item:", swduce);

		const liu = items.find(i => i.citekey === 'Liu24kolmogArnoldKAN');
		console.log("Liu item:", liu);
	}, 30000);
});
