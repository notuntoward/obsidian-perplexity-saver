// Minimal mock of the type-only `obsidian` package so that unit tests can
// resolve `import { ... } from "obsidian"` without the real Obsidian runtime.
// Extend these stubs as your tests need them.
import { StateField } from "@codemirror/state";

export const editorInfoField = StateField.define<{ file: { path: string } | null }>({
	create: () => ({ file: null }),
	update: (value) => value,
});

export function getFrontMatterInfo(content: string): { exists: boolean; frontmatter: string; contentStart: number } {
	const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	return match
		? { exists: true, frontmatter: match[1], contentStart: match[0].length }
		: { exists: false, frontmatter: "", contentStart: 0 };
}

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
	register(_cleanup: () => void): void {}
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

export class MarkdownView {
	file: any;
	containerEl: any;
	editor: any;

	constructor() {
		this.editor = { focus(): void {}, getValue: (): string => "" };
	}

	getViewType(): string {
		return "markdown";
	}

	getMode(): "source" | "preview" {
		return "source";
	}

	addAction(_icon: string, _title: string, callback: (event: MouseEvent) => void): HTMLElement {
		const element = this.containerEl.ownerDocument.createElement("button");
		element.addEventListener("click", callback);
		this.containerEl.appendChild(element);
		return element;
	}
}

export function setIcon(element: HTMLElement, icon: string): void {
	element.dataset.icon = icon;
}

export function setTooltip(element: HTMLElement, tooltip: string): void {
	element.setAttribute("aria-label", tooltip);
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

export class DropdownComponent {
	selectEl: HTMLSelectElement;
	constructor(parent: HTMLElement) { this.selectEl = parent.createEl("select"); }
	addOptions(options: Record<string, string>): this {
		for (const [value, text] of Object.entries(options)) this.selectEl.createEl("option", { text }).value = value;
		return this;
	}
	setValue(value: string): this { this.selectEl.value = value; return this; }
	onChange(callback: (value: string) => void): this {
		this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
		return this;
	}
}

export class Notice {
	message: string;
	timeout?: number;
	messageEl: HTMLElement = typeof document === "undefined" ? (undefined as unknown as HTMLElement) : document.createElement("div");
	hidden = false;

	constructor(message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
		createdNotices.push(this);
	}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
	hide(): void { this.hidden = true; }
}

export const createdNotices: Notice[] = [];

export function installEditorDomHelpers(doc: Document): void {
	const createEl = function(this: HTMLElement | DocumentFragment, tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement {
		const el = this.ownerDocument!.createElement(tag);
		if (options?.cls) el.className = options.cls;
		if (options?.text) el.textContent = options.text;
		for (const [name, value] of Object.entries(options?.attr ?? {})) el.setAttribute(name, value);
		this.appendChild(el);
		return el;
	};
	const elementPrototype = Object.getPrototypeOf(Object.getPrototypeOf(doc.createElement("div")));
	const fragmentPrototype = Object.getPrototypeOf(doc.createDocumentFragment());
	for (const prototype of [elementPrototype, fragmentPrototype]) {
		Object.defineProperty(prototype, "createEl", { value: createEl, configurable: true });
		Object.defineProperty(prototype, "createSpan", {
			value: function(this: HTMLElement | DocumentFragment, options?: { cls?: string; text?: string }) {
				return createEl.call(this, "span", options);
			},
			configurable: true,
		});
		Object.defineProperty(prototype, "createDiv", {
			value: function(this: HTMLElement | DocumentFragment, options?: { cls?: string; text?: string }) {
				return createEl.call(this, "div", options);
			},
			configurable: true,
		});
	}
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

/** Real DOM counterpart for modal layout and accessibility tests. */
export class DomModal {
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	closed = false;

	constructor(doc: Document) {
		installEditorDomHelpers(doc);
		this.modalEl = doc.createElement("div");
		this.modalEl.className = "modal";
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
		doc.body.appendChild(this.modalEl);
	}

	open(): void { this.onOpen(); }
	close(): void { this.closed = true; this.onClose(); this.modalEl.remove(); }
	onOpen(): void {}
	onClose(): void {}
}

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
	setPlaceholder(_placeholder: string): this {
		return this;
	}
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

export class ItemView extends Component {
	leaf: any;
	app: any;
	contentEl: any;

	constructor(leaf: any) {
		super();
		this.leaf = leaf;
		this.app = leaf?.app;
	}
	registerEvent(_event: any): void {}
	async setState(_state: unknown, _result: unknown): Promise<void> {}
	getState(): Record<string, unknown> {
		return {};
	}
}

export class FileSystemAdapter {
	constructor(private basePath = "") {}
	getBasePath(): string { return this.basePath; }
}

export class TFile {
	path: string;
	parent: { path: string } | null;

	constructor(path: string, parentPath: string | null = null) {
		this.path = path;
		this.parent = parentPath ? { path: parentPath } : null;
	}
}

export class TFolder {
	path: string;
	children: (TFile | TFolder)[];

	constructor(path: string, children: (TFile | TFolder)[] = []) {
		this.path = path;
		this.children = children;
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
	let currentKey: string | null = null;

	for (const line of input.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (trimmed.startsWith("- ") && currentKey) {
			let itemVal: unknown = trimmed.slice(2).trim();
			if (typeof itemVal === "string" && /^["'].*["']$/.test(itemVal)) {
				itemVal = itemVal.slice(1, -1).replace(/\\"/g, '"');
			}
			if (!Array.isArray(result[currentKey])) {
				result[currentKey] = [];
			}
			(result[currentKey] as unknown[]).push(itemVal);
			continue;
		}

		const m = trimmed.match(/^([A-Za-z0-9_\-\"'\s]+):\s*(.*)$/);
		if (!m) continue;
		const rawKey = m[1].trim();
		const key = rawKey.replace(/^["']|["']$/g, "").trim();
		currentKey = key;
		let value: unknown = m[2].trim();

		if (typeof value === "string" && /^["'].*["']$/.test(value)) {
			value = value.slice(1, -1).replace(/\\"/g, '"');
		}
		if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
			const inner = value.slice(1, -1).trim();
			value = inner.length === 0 ? [] : inner.split(",").map((s) => s.trim());
		}

		if (value !== "" && value !== null) {
			result[key] = value;
		} else {
			result[key] = result[key] ?? [];
		}
	}
	return result;
}
export function htmlToMarkdown(html: string): string {
	return html.replace(/<h1>(.*?)<\/h1>/g, "# $1").replace(/<[^>]*>?/gm, "");
}
export class FuzzySuggestModal<T> extends SuggestModal<T> {}
