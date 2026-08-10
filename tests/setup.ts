// Vitest runs in the "node" environment (see vitest.config.ts) rather than a
// browser/DOM environment, since most of this codebase doesn't need real DOM
// APIs. Obsidian's own runtime, however, is a browser/Electron renderer
// where `window` IS the global object, so plugin source code is required (by
// the obsidianmd/prefer-window-timers lint rule) to call `window.setTimeout`
// / `window.clearTimeout` rather than the bare globals, for correctness
// across Obsidian's popout windows.
//
// Polyfill `window` as an alias to `globalThis` here so code under test can
// call `window.setTimeout`/`window.clearTimeout` and resolve to the same
// real (or, under `vi.useFakeTimers()`, faked) timers Node/Vitest already
// provide, without pulling in a full DOM environment like jsdom just for
// this. This mirrors real browser semantics, where `window === globalThis`.
if (typeof (globalThis as unknown as { window?: unknown }).window === "undefined") {
	(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}
