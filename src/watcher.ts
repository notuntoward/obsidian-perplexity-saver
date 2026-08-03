import { App, Notice, Platform } from "obsidian";

let fs: typeof import("fs") | null = null;
let path: typeof import("path") | null = null;
let os: typeof import("os") | null = null;
let electronClipboard: any = null;

if (!Platform.isMobile) {
	try {
		fs = require("fs");
		path = require("path");
		os = require("os");
		electronClipboard = require("electron").clipboard;
	} catch (e) {
		console.error("Failed to load Node/Electron modules for Perplexity Saver watcher:", e);
	}
}

export function getDefaultDownloadsFolder(): string {
	if (!os || !path) {
		return "";
	}
	return path.join(os.homedir(), "Downloads");
}

export function expandTilde(filepath: string): string {
	if (!os || !path) return filepath;
	if (filepath.startsWith("~/") || filepath === "~") {
		return path.join(os.homedir(), filepath.slice(2));
	}
	return filepath;
}

export class DownloadsWatcher {
	private intervalId: number | null = null;
	private isWatchingDownloads = false;

	constructor(
		private app: App,
		private getSettings: () => {
			enableDownloadsWatcher: boolean;
			downloadsFolderPath: string;
		}
	) {}

	start(): void {
		if (Platform.isMobile) {
			return;
		}

		if (this.intervalId !== null) {
			this.stop();
		}

		// Check the clipboard every 1000ms
		this.intervalId = window.setInterval(async () => {
			const settings = this.getSettings();
			if (!settings.enableDownloadsWatcher) {
				return;
			}

			// If we are already in the middle of waiting for a download, don't trigger again
			if (this.isWatchingDownloads) {
				return;
			}

			let clipboardText = "";
			try {
				if (electronClipboard) {
					clipboardText = electronClipboard.readText();
				} else {
					clipboardText = await navigator.clipboard.readText();
				}
			} catch (e) {
				// Accessing clipboard can fail if the window is out of focus; ignore silently
				return;
			}

			if (clipboardText && clipboardText.startsWith("__PPLX_EXPORT_METADATA__:")) {
				const jsonStr = clipboardText.slice("__PPLX_EXPORT_METADATA__:".length);
				try {
					const metadata = JSON.parse(jsonStr);
					await this.handleExportMetadata(metadata);
				} catch (err) {
					console.error("Perplexity Saver: failed to parse metadata JSON", err);
				}
			}
		}, 1000);
	}

	stop(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private async writeToClipboard(text: string): Promise<void> {
		try {
			if (electronClipboard) {
				electronClipboard.writeText(text);
			} else {
				await navigator.clipboard.writeText(text);
			}
		} catch (e) {
			console.error("Failed to write to clipboard:", e);
		}
	}

	private async handleExportMetadata(metadata: { url: string; timestamp: string; clickTime: number }): Promise<void> {
		this.isWatchingDownloads = true;

		// Immediately clear clipboard so we don't process it again
		await this.writeToClipboard("");

		const notice = new Notice("Perplexity Export: Waiting for download...", 15000);

		const settings = this.getSettings();
		const rawPath = settings.downloadsFolderPath.trim() || getDefaultDownloadsFolder();
		const downloadsDir = expandTilde(rawPath);

		if (!fs || !path || !downloadsDir || !fs.existsSync(downloadsDir)) {
			notice.hide();
			new Notice(`Perplexity Export: Downloads directory not found: ${downloadsDir}`);
			this.isWatchingDownloads = false;
			return;
		}

		const startTime = Date.now();
		const timeoutMs = 15000;
		const pollIntervalMs = 200;

		const poll = async () => {
			if (Date.now() - startTime > timeoutMs) {
				notice.hide();
				new Notice("Perplexity Export: Timeout waiting for download. Please try again.");
				this.isWatchingDownloads = false;
				return;
			}

			try {
				const files = fs!.readdirSync(downloadsDir);
				const candidates: { name: string; mtimeMs: number; size: number }[] = [];

				for (const file of files) {
					if (file.startsWith(".") || !file.toLowerCase().endsWith(".md")) {
						continue;
					}

					const fullPath = path!.join(downloadsDir, file);
					try {
						const stats = fs!.statSync(fullPath);
						// Match files created/modified around or after the clickTime
						// Allowing slightly earlier times (up to 5 seconds) to account for system clock drift
						if (stats.mtimeMs > metadata.clickTime - 5000) {
							candidates.push({
								name: file,
								mtimeMs: stats.mtimeMs,
								size: stats.size,
							});
						}
					} catch (e) {
						// File might be in the middle of creation or locked; ignore
					}
				}

				if (candidates.length > 0) {
					// Sort descending by modification time
					candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
					const bestFile = candidates[0];
					const fullPath = path!.join(downloadsDir, bestFile.name);

					// Wait for file size to stabilize to ensure download is complete
					await new Promise((resolve) => window.setTimeout(resolve, 100));
					const stats2 = fs!.statSync(fullPath);

					if (stats2.size > 0 && stats2.size === bestFile.size) {
						// Download completed successfully
						const content = fs!.readFileSync(fullPath, "utf-8");

						// Wrap markdown
						const finalMd = `[Perplexity](${metadata.url}) · *${metadata.timestamp}*\n${content.trim()}\n`;

						// Copy back to clipboard
						await this.writeToClipboard(finalMd);

						// Delete downloaded file
						try {
							fs!.unlinkSync(fullPath);
						} catch (err) {
							console.error(`Perplexity Saver: failed to delete ${fullPath}`, err);
						}

						notice.hide();
						new Notice("Perplexity Export: Clipboard updated with Obsidian Markdown.");
						this.isWatchingDownloads = false;
						return;
					}
				}

				// If not found or not completed, schedule next poll
				window.setTimeout(poll, pollIntervalMs);
			} catch (err) {
				console.error("Perplexity Saver error during downloads poll:", err);
				window.setTimeout(poll, pollIntervalMs);
			}
		};

		await poll();
	}
}