// Minimal mock of the type-only `obsidian` package so that unit tests can
// resolve `import { ... } from "obsidian"` without the real Obsidian runtime.
// Extend these stubs as your tests need them.

export class Plugin {
	app: any;
	manifest: any;

	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}

	async onload(): Promise<void> {}
	onunload(): void {}
	addCommand(_command: any): any {}
	addSettingTab(_tab: any): void {}
	registerEvent(_event: any): void {}
	registerDomEvent(_el: any, _type: string, _callback: any): void {}
	registerInterval(_id: number): number {
		return _id;
	}
	registerEditorExtension(_extension: any): void {}
	async loadData(): Promise<any> {
		return {};
	}
	async saveData(_data: any): Promise<void> {}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {}
	hide(): void {}
	refreshDomState(): void {}
}

export class Setting {
	containerEl: any;
	settingEl: any;

	constructor(_containerEl: any) {
		this.containerEl = _containerEl;
	}

	setName(_name: string): this {
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	addText(_cb: (text: any) => any): this {
		return this;
	}
	addToggle(_cb: (toggle: any) => any): this {
		return this;
	}
	addButton(_cb: (button: any) => any): this {
		return this;
	}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
	setMessage(_message: string): this {
		return this;
	}
	hide(): void {}
}

export class Modal {
	app: any;
	titleEl: MockElement;
	contentEl: MockElement;
	modalEl: MockElement;

	constructor(app: any) {
		this.app = app;
		this.titleEl = new MockElement("h2");
		this.contentEl = new MockElement("div");
		this.modalEl = new MockElement("div");
		createdModals.push(this);
	}

	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

/** Registry of Modal instances so tests can drive button clicks. */
export const createdModals: Modal[] = [];

/**
 * Tiny DOM-element stand-in so modal code can build button rows and tests can
 * find and click the buttons without a real DOM.
 */
export class MockElement {
	tag: string;
	text = "";
	cls = "";
	children: MockElement[] = [];
	listeners: Record<string, Array<() => void>> = {};

	constructor(tag: string) {
		this.tag = tag;
	}

	setText(text: string): this {
		this.text = text;
		return this;
	}
	createEl(tag: string, opts?: { text?: string; cls?: string }): MockElement {
		const el = new MockElement(tag);
		if (opts?.text) el.text = opts.text;
		if (opts?.cls) el.cls = opts.cls;
		this.children.push(el);
		return el;
	}
	createDiv(opts?: { text?: string; cls?: string }): MockElement {
		return this.createEl("div", opts);
	}
	addClass(cls: string): void {
		this.cls = this.cls ? `${this.cls} ${cls}` : cls;
	}
	empty(): this {
		this.children = [];
		this.text = "";
		return this;
	}
	addEventListener(type: string, cb: () => void): void {
		(this.listeners[type] ??= []).push(cb);
	}
}

export class SuggestModal<T> {
	app: any;
	inputEl: any = { value: "" };

	constructor(app: any) {
		this.app = app;
	}

	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
	getSuggestions(_query: string): T[] {
		return [];
	}
	renderSuggestion(_item: T, _el: any): void {}
	onChooseSuggestion(_item: T, _evt: any): void {}
}

export function prepareFuzzySearch(_query: string): any {
	return (_text: string) => null;
}

export function renderResults(_el: any, _text: string, _match: any): void {}

export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
}

export class TFile {
	path: string;
	parent: { path: string } | null;

	constructor(path: string, parentPath: string | null = null) {
		this.path = path;
		this.parent = parentPath ? { path: parentPath } : null;
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export let requestUrlMock = vi.fn().mockResolvedValue({
	status: 200,
	headers: { "content-type": "text/html" },
	text: "<html><head><title>Test Title</title></head></html>"
});

export function requestUrl(options: any): Promise<any> {
	return requestUrlMock(options);
}

// Minimal YAML subset parser used by normalize/frontmatter.ts. Handles
// the limited frontmatter shapes that pasted AI dialogs might carry
// (key: value lines, no nested objects). Sufficient for the strip-leading
// fence helper; not a full YAML implementation.
export function parseYaml(input: string): unknown {
	const result: Record<string, unknown> = {};
	for (const line of input.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const m = trimmed.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		let value: unknown = m[2].trim();
		// Drop surrounding quotes if present.
		if (typeof value === "string" && /^["'].*["']$/.test(value as string)) {
			value = (value as string).slice(1, -1);
		}
		// Simple list form: [a, b, c]
		if (typeof value === "string" && (value as string).startsWith("[") && (value as string).endsWith("]")) {
			const inner = (value as string).slice(1, -1).trim();
			value = inner.length === 0 ? [] : inner.split(",").map((s) => s.trim());
		}
		result[key] = value;
	}
	return result;
}
export function htmlToMarkdown(html: string): string {
	return html.replace(/<h1>(.*?)<\/h1>/g, "# $1").replace(/<[^>]*>?/gm, "");
}
export class FuzzySuggestModal<T> extends SuggestModal<T> {}
