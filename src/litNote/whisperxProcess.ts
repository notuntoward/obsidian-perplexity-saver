import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

export interface WhisperxProcessOptions {
	pythonPath: string;
	helperPath: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export async function runWhisperx(
	request: unknown,
	options: WhisperxProcessOptions
): Promise<unknown> {
	const directory = await mkdtemp(path.join(tmpdir(), "saver-whisperx-job-"));
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(
				options.pythonPath,
				["-u", options.helperPath, "--work-dir", directory],
				{
					shell: false,
					windowsHide: true,
					signal: options.signal,
					timeout: 3 * 60 * 60 * 1000,
					env: { ...process.env, PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
				}
			);
			let stdout = "";
			let stderr = "";
			let outputExceeded = false;
			let processError: Error | null = null;
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (outputExceeded) return;
				stdout += chunk;
				if (Buffer.byteLength(stdout) > 32 * 1024 * 1024) {
					outputExceeded = true;
					child.kill();
				}
			});
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-8000);
				const progress = chunk
					.split(/\r?\n/)
					.reverse()
					.find((line) =>
						/^(Checking YouTube|Downloading matching|Decoding audio|Aligning audio:)/.test(line)
					);
				if (progress) options.onProgress?.(progress);
			});
			child.on("error", (error) => {
				processError = new Error(
					options.signal?.aborted
						? "WhisperX alignment cancelled; the note was not changed."
						: `Could not run WhisperX. Check the Python path and install scripts/whisperx/requirements.txt. ${error.message}`
				);
			});
			child.stdin.on("error", (error) => {
				processError = new Error(`Could not send transcript to WhisperX: ${error.message}`);
				child.kill();
			});
			child.on("close", (code, signal) => {
				if (outputExceeded)
					reject(new Error("WhisperX output exceeded the 32 MB safety limit."));
				else if (processError) reject(processError);
				else if (code !== 0)
					reject(new Error(`WhisperX failed (${signal ?? code}). ${stderr.trim()}`));
				else {
					try {
						const result: unknown = JSON.parse(stdout);
						resolve(result);
					} catch {
						reject(new Error("WhisperX did not return valid alignment JSON."));
					}
				}
			});
			child.stdin.end(JSON.stringify(request));
		});
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}
