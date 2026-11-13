"""Use YouTube word offsets first; force-align missing words inside caption anchors."""

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import sys
import tempfile

ENGINE = "whisperx-3.8.6"
MODEL = "WAV2VEC2_ASR_BASE_960H"


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_captions(data, duration):
    events = [event for event in data["events"]
              if any(segment.get("utf8", "").strip() for segment in event.get("segs", []))]
    words, captions = [], []
    for index, event in enumerate(events):
        start = event["tStartMs"] / 1000
        following = events[index + 1]["tStartMs"] / 1000 if index + 1 < len(events) else duration
        end = min(duration, following, start + event.get("dDurationMs", (following - start) * 1000) / 1000)
        if not finite(start) or not finite(end) or not 0 <= start < end:
            raise ValueError("Invalid or overlapping caption-start anchors.")
        text, segments = "", []
        for position, segment in enumerate(event["segs"]):
            part = segment.get("utf8", "")
            offset = segment.get("tOffsetMs", 0 if position == 0 else None)
            time = start + offset / 1000 if finite(offset) else None
            segments.append((len(text), len(text) + len(part), time))
            text += part
        first = len(words)
        for match in re.finditer(r"\S+", text):
            segment = next(part for part in segments if part[0] <= match.start() < part[1])
            # A multiword segment times its first word, not every word inside it.
            leading = text[segment[0]:match.start()].strip()
            time = segment[2] if not leading else None
            if len(words) == first:
                time = start
            if time is not None and not start <= time < end:
                raise ValueError("YouTube word offset crosses its caption boundary.")
            words.append({"text": match.group(), "time": time})
        captions.append({"first": first, "last": len(words), "start": start, "end": end})
    return words, captions


def canonical(text):
    return re.sub(r"\W", "", text.casefold())


def match_captions(expected, words):
    return [canonical(word) for word in expected] == [canonical(word["text"]) for word in words]


def merge_alignment(words, aligned, caption):
    if [word["word"] for word in aligned] != [word["text"] for word in words]:
        raise ValueError("WhisperX changed the caption word sequence.")
    results = []
    previous_end = caption["start"]
    for index, (word, acoustic) in enumerate(zip(words, aligned)):
        if word["time"] is not None:
            results.append([word["time"], None, None])
            previous_end = word["time"]
            continue
        values = [acoustic.get(key) for key in ("start", "end", "score")]
        next_anchor = next((later["time"] for later in words[index + 1:] if later["time"] is not None), caption["end"])
        if all(finite(value) for value in values):
            start, end, score = values
            start += caption["start"]
            end += caption["start"]
            if (previous_end <= start < end <= next_anchor and 0.3 <= score <= 1
                    and not re.search(r"\d", word["text"])):
                results.append([start, end, score])
                previous_end = end
                continue
        results.append(None)
    return results


def fetch_matching_captions(downloader, info, expected):
    candidates = []
    for collection in ("subtitles", "automatic_captions"):
        tracks = info.get(collection, {})
        for language in ("en-orig", "en"):
            candidates.extend(track for track in tracks.get(language, []) if track["ext"] == "json3")
    seen = set()
    for track in candidates:
        if track["url"] in seen:
            continue
        seen.add(track["url"])
        with downloader.urlopen(track["url"]) as response:
            raw = response.read()
        words, captions = parse_captions(json.loads(raw), info["duration"])
        if match_captions(expected, words):
            return words, captions, hashlib.sha256(raw).hexdigest()
    raise ValueError("No matching original English JSON3 captions. Caption anchors cannot safely be recovered; nothing was saved.")


def run(request):
    if (request.get("version") != 2 or not re.fullmatch(r"[\w-]{11}", request.get("videoId", ""), re.ASCII)
            or not re.fullmatch(r"[a-f0-9]{64}", request.get("sourceHash", ""))):
        raise ValueError("Invalid caption-timing request. Reload the updated plugin.")
    expected = [word["text"] for word in request["words"]]
    if not expected or any(not word or re.search(r"\s", word) for word in expected):
        raise ValueError("Invalid transcript words.")
    import yt_dlp

    url = f'https://www.youtube.com/watch?v={request["videoId"]}'
    settings = {
        "format": "bestaudio/best", "quiet": True, "noprogress": True, "noplaylist": True,
        "socket_timeout": 30, "retries": 2, "fragment_retries": 2, "js_runtimes": {"node": {}},
    }
    print("Checking YouTube word offsets...", file=sys.stderr, flush=True)
    with yt_dlp.YoutubeDL(settings) as downloader:
        info = downloader.extract_info(url, download=False)
        if info.get("id") != request["videoId"] or not finite(info.get("duration")):
            raise ValueError("Caption video identity/duration could not be verified.")
        words, captions, caption_hash = fetch_matching_captions(downloader, info, expected)
    results = [[word["time"], None, None] if word["time"] is not None else None for word in words]
    sources = ["youtube" if result is not None else "unmatched" for result in results]
    for caption in captions:
        sources[caption["first"]] = "caption"
    missing = [caption for caption in captions if any(result is None for result in results[caption["first"]:caption["last"]])]
    audio_hash = None
    if missing:
        if importlib.metadata.version("whisperx") != "3.8.6":
            raise ValueError("Install scripts/whisperx/requirements.txt for missing word timings.")
        import torch
        import whisperx
        device = "cuda" if torch.cuda.is_available() else "cpu"
        torch.set_num_threads(min(4, torch.get_num_threads()))
        print(f"Aligning audio: {len(missing)} captions have missing word offsets ({device})",
              file=sys.stderr, flush=True)
        model, metadata = whisperx.load_align_model(language_code="en", device=device, model_name=MODEL)
        digest = hashlib.sha256()
        for index, caption in enumerate(missing):
            start, end = caption["start"], caption["end"]
            if end - start > 120:
                raise ValueError("Caption interval exceeds the bounded 120-second alignment limit.")
            first, last = caption["first"], caption["last"]
            print(f"Aligning audio: caption {index + 1}/{len(missing)}, fixed interval {start:.3f}-{end:.3f}",
                  file=sys.stderr, flush=True)
            with tempfile.TemporaryDirectory(prefix="caption-", dir=request["workDir"]) as directory:
                with yt_dlp.YoutubeDL({
                    **settings, "outtmpl": str(Path(directory) / "audio.%(ext)s"),
                    "download_ranges": yt_dlp.utils.download_range_func(None, [(start, end)]),
                    "force_keyframes_at_cuts": True,
                }) as downloader:
                    section = downloader.extract_info(url, download=True)
                    audio_path = downloader.prepare_filename(section)
                with open(audio_path, "rb") as audio_file:
                    digest.update(audio_file.read())
                audio = whisperx.load_audio(str(audio_path))
                local_end = min(end - start, len(audio) / 16000)
                aligned = whisperx.align(
                    [{"start": 0, "end": local_end, "text": " ".join(word["text"] for word in words[first:last])}],
                    model, metadata, audio, device, print_progress=False,
                )["word_segments"]
                if not aligned:
                    continue
                merged = merge_alignment(words[first:last], aligned, caption)
                results[first:last] = merged
                for position in range(first, last):
                    if words[position]["time"] is None and results[position] is not None:
                        sources[position] = "acoustic"
        audio_hash = digest.hexdigest()
    return {
        "version": 2, "sourceHash": request["sourceHash"], "videoId": request["videoId"],
        "engine": ENGINE if missing else "youtube-json3", "model": MODEL if missing else None,
        "paddingSeconds": 0, "createdAt": datetime.now(timezone.utc).isoformat(),
        "audioSha256": audio_hash, "captionSha256": caption_hash, "audioDuration": info["duration"],
        "captions": captions, "wordSources": sources, "words": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", required=True)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    request["workDir"] = args.work_dir
    with contextlib.redirect_stdout(sys.stderr):
        result = run(request)
    json.dump(result, sys.stdout, allow_nan=False)


if __name__ == "__main__":
    main()
