import { describe, expect, it, vi } from "vitest";
import { runWhisperx } from "../../src/litNote/whisperxProcess";

// Use Node as a tiny protocol peer; these tests need neither Python nor model downloads.
const helper = (source: string) => ({
	pythonPath: process.execPath,
	helperPath: source,
});

vi.mock("child_process", async (original) => {
	const actual = await original<typeof import("child_process")>();
	return {
		...actual,
		spawn: (command: string, args: string[], options: import("child_process").SpawnOptions) =>
			actual.spawn(command, ["-e", args[1]], options),
	};
});

describe("WhisperX local process protocol", () => {
	it("transfers Unicode JSON without shell interpolation and reports progress", async () => {
		const progress = vi.fn();
		const result = await runWhisperx({ text: "résumé $HOME `echo nope`" }, {
			...helper("process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{process.stderr.write('Aligning audio: 1/1 windows\\n');process.stdout.write(s)});"),
			onProgress: progress,
		});
		expect(result).toEqual({ text: "résumé $HOME `echo nope`" });
		expect(progress).toHaveBeenCalledWith("Aligning audio: 1/1 windows");
	});

	it("surfaces nonzero exits and malformed output, and cancels a real child", async () => {
		await expect(runWhisperx({}, helper("process.stderr.write('Download unavailable');process.exit(3)")))
			.rejects.toThrow("Download unavailable");
		await expect(runWhisperx({}, helper("process.stdout.write('not json')"))).rejects.toThrow("valid alignment JSON");
		const controller = new AbortController();
		const running = runWhisperx({}, {
			...helper("process.stderr.write('Aligning audio: waiting\\n');setInterval(()=>{},1000)"),
			signal: controller.signal,
			onProgress: () => controller.abort(),
		});
		await expect(running).rejects.toThrow("cancelled");
	});
});
