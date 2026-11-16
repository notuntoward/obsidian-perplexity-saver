import { Modal, type App } from "obsidian";
import { closeOnEscapeFromOtherWindows } from "commons/modal";
import type { NotePlayback } from "./backgroundPlayback";
import { formatClock, parseYouTubeTime } from "./youtubeLinks";

type SeekablePlayback = Pick<NotePlayback, "getPlaybackToken" | "getDuration" | "seekTo">;

export function openGoToTime(app: App, playback: SeekablePlayback): void {
	const token = playback.getPlaybackToken();
	new (class extends Modal {
		private cleanupEscape?: () => void;

		onOpen(): void {
			this.titleEl.setText("Go to time");
			const form = this.contentEl.createEl("form");
			form.createEl("p", { text: "Enter seconds, m:ss, or h:mm:ss." });
			const input = form.createEl("input", {
				attr: { type: "text", "aria-label": "Video timestamp", placeholder: "1:23", autocomplete: "off" },
			});
			const error = form.createDiv({ attr: { role: "alert" } });
			const buttons = form.createDiv({ cls: "modal-button-container" });
			const cancel = buttons.createEl("button", { text: "Cancel", attr: { type: "button" } });
			cancel.addEventListener("click", () => this.close());
			buttons.createEl("button", { text: "Go to time", cls: "mod-cta", attr: { type: "submit" } });
			input.addEventListener("input", () => error.setText(""));
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				const current = playback.getPlaybackToken();
				if (!token || !current || current.player !== token.player || current.revision !== token.revision) {
					error.setText("Playback changed. Open go to time again.");
					return;
				}
				const value = input.value.trim();
				const parts = value.split(":");
				const seconds = parseYouTubeTime(value);
				if (seconds === null || !Number.isFinite(seconds) ||
					(parts.length > 1 && parts.slice(1).some((part) => Number(part) >= 60))) {
					error.setText("Enter a valid timestamp, such as 1:23 or 1:02:03.");
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
