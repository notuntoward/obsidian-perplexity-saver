import { prepareTranscript, type AlignmentCache } from "commons/youtube";

const transcript = prepareTranscript([
	{
		startSec: 21,
		endSec: 30,
		url: "https://youtu.be/abcdefghijk?t=21",
		text: "We left. We stayed.",
	},
]);

/** WhisperX cache for the one-caption transcript "We left. We stayed." at 21–30 s. */
export function cacheForTest(): AlignmentCache {
	return {
		version: 2,
		sourceHash: transcript.hash,
		videoId: "abcdefghijk",
		engine: "whisperx-3.8.6",
		model: "WAV2VEC2_ASR_BASE_960H",
		paddingSeconds: 0,
		createdAt: "2026-11-13T00:00:00Z",
		audioSha256: "a".repeat(64),
		audioDuration: 100,
		captionSha256: "b".repeat(64),
		captions: [{ first: 0, last: 4, start: 21, end: 30 }],
		wordSources: ["caption", "acoustic", "acoustic", "acoustic"],
		words: [
			[21, null, null],
			[21.4, 22, 0.9],
			[25, 25.3, 0.8],
			[25.4, 26, 0.8],
		],
	};
}
