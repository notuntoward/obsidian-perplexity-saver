import { Modal, type App } from "obsidian";
import { applyModalAppearance, closeOnEscapeFromOtherWindows } from "commons/modal";
import { isValidYouTubeUrl, formatClock, parseYouTubeTime } from "commons/youtube";
import type { NotePlayback } from "./backgroundPlayback";

type SeekablePlayback = Pick<NotePlayback, "getVideoId" | "getPlaybackToken" | "getDuration" | "seekTo">;

function validTime(value: string): number | null {
	const parts = value.split(":");
	const seconds = parseYouTubeTime(value);
	return seconds !== null && Number.isFinite(seconds) &&
		(parts.length === 1 || parts.slice(1).every((part) => Number(part) < 60))
		? seconds : null;
}

export function openGoToTime(app: App, playback: SeekablePlayback): void {
	const token = playback.getPlaybackToken();
	const videoId = playback.getVideoId();
	new (class extends Modal {
		private cleanupEscape?: () => void;

		onOpen(): void {
			this.titleEl.setText("Go to time");
			applyModalAppearance(this, { size: "compact" });
			const form = this.contentEl.createEl("form");
			const field = form.createEl("label", { cls: "commons-modal-field" });
			field.createSpan({ text: "Timestamp" });
			const control = field.createSpan({ cls: "commons-modal-control" });
			const formatHelp = "Seconds, m:ss, h:mm:ss, or a timestamped YouTube URL. Paste to seek.";
			const input = control.createEl("input", {
				cls: "commons-modal-input",
				attr: { type: "text", "aria-label": "Video timestamp", "aria-description": formatHelp, placeholder: "1:23", autocomplete: "off" },
			});
			control.createSpan({ cls: "commons-modal-description", text: formatHelp });
			const error = form.createDiv({ cls: "commons-modal-error", attr: { role: "alert" } });
			const buttons = form.createDiv({ cls: "modal-button-container commons-modal-actions" });
			const cancel = buttons.createEl("button", { text: "Cancel", attr: { type: "button" } });
			cancel.addEventListener("click", () => this.close());
			buttons.createEl("button", { text: "Go to time", cls: "mod-cta", attr: { type: "submit" } });
			input.addEventListener("input", () => error.setText(""));
			const submit = () => {
				const current = playback.getPlaybackToken();
				if (!token || !current || current.player !== token.player || current.revision !== token.revision ||
					playback.getVideoId() !== videoId) {
					error.setText("Playback changed. Open go to time again.");
					return;
				}
				const value = input.value.trim();
				let seconds: number | null;
				if (isValidYouTubeUrl(value)) {
					const url = new URL(value);
					if (url.protocol !== "https:" && url.protocol !== "http:") {
						error.setText("Enter a valid timestamped YouTube URL.");
						return;
					}
					const segments = url.pathname.split("/");
					if ((url.hostname.endsWith("youtu.be") && segments.slice(2).some(Boolean)) ||
						(url.pathname !== "/watch" && !url.hostname.endsWith("youtu.be") && segments.slice(3).some(Boolean))) {
						error.setText("Enter a valid timestamped YouTube URL.");
						return;
					}
					const linkedVideoId = url.hostname.endsWith("youtu.be")
						? segments[1] : url.pathname === "/watch" ? url.searchParams.get("v") : segments[2];
					if (!videoId || linkedVideoId !== videoId) {
						error.setText("This YouTube URL is not for the current video.");
						return;
					}
					const time = url.searchParams.get("t") ?? url.searchParams.get("start") ??
						new URLSearchParams(url.hash.slice(1)).get("t");
					seconds = validTime(time ?? "");
				} else {
					seconds = validTime(value);
				}
				if (seconds === null) {
					error.setText("Enter a valid timestamp or timestamped YouTube URL.");
					return;
				}
				const duration = playback.getDuration();
				if (!Number.isFinite(duration) || duration <= 0) {
					error.setText("Video duration is not available yet. Try again when the video has loaded.");
					return;
				}
				if (seconds > duration) {
					error.setText(`Time exceeds the video duration (${formatClock(duration)}).`);
					return;
				}
				playback.seekTo(seconds);
				this.close();
			};
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				submit();
			});
			input.addEventListener("paste", (event) => {
				const text = event.clipboardData?.getData("text/plain");
				if (!text) return;
				event.preventDefault();
				input.setRangeText(text, input.selectionStart ?? 0, input.selectionEnd ?? 0, "end");
				submit();
			});
			this.cleanupEscape = closeOnEscapeFromOtherWindows(this);
			input.focus();
		}

		onClose(): void {
			this.cleanupEscape?.();
			this.contentEl.empty();
		}
	})(app).open();
}
