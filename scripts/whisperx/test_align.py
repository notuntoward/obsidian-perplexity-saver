import unittest
from unittest.mock import Mock, patch
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace

import align
from align import parse_captions, match_captions, merge_alignment, run


class CaptionTimingTests(unittest.TestCase):
    def data(self):
        return {"events": [
            {"tStartMs": 12000, "dDurationMs": 8000, "segs": [
                {"utf8": "We"}, {"utf8": " left.", "tOffsetMs": 200},
                {"utf8": " We", "tOffsetMs": 900}, {"utf8": " stayed.", "tOffsetMs": 1100}]},
            {"tStartMs": 14000, "dDurationMs": 1000, "segs": [{"utf8": "Next."}]},
        ]}

    def test_native_offsets_need_no_inference_and_respect_the_next_caption(self):
        words, captions = parse_captions(self.data(), 16)
        self.assertEqual([word["time"] for word in words], [12, 12.2, 12.9, 13.1, 14])
        self.assertEqual(captions[0]["end"], 14)
        self.assertTrue(match_captions(["We", "left.", "We", "stayed.", "Next."], words))
        self.assertFalse(match_captions(["We", "changed."], words))

    def test_does_not_invent_word_offsets_inside_multiword_segments(self):
        data = {"events": [{"tStartMs": 1000, "dDurationMs": 3000,
                            "segs": [{"utf8": "We left. We stayed."}]}]}
        words, captions = parse_captions(data, 4)
        self.assertEqual([word["time"] for word in words], [1, None, None, None])
        self.assertEqual(captions[0]["start"], 1)

    def test_native_word_can_tie_the_next_caption_start_without_float_drift(self):
        data = {"events": [
            {"tStartMs": 342194, "dDurationMs": 3500, "segs": [
                {"utf8": "We"}, {"utf8": " left.", "tOffsetMs": 1100}]},
            {"tStartMs": 343294, "dDurationMs": 1000, "segs": [{"utf8": "Next."}]},
        ]}
        words, captions = parse_captions(data, 350)
        self.assertEqual([word["time"] for word in words], [342.194, 343.294, 343.294])
        self.assertEqual(captions[0]["end"], 343.294)

    def test_rejects_native_offsets_that_really_exceed_a_caption_boundary(self):
        data = self.data()
        data["events"][0]["segs"][-1]["tOffsetMs"] = 2001
        with self.assertRaisesRegex(ValueError, "crosses its caption boundary"):
            parse_captions(data, 16)

    def test_forced_alignment_pins_caption_start_and_rejects_cross_boundary_words(self):
        words, captions = parse_captions(self.data(), 16)
        words[1]["time"] = None
        words[2]["time"] = None
        words[3]["time"] = None
        result = merge_alignment(words[:4], [
            {"word": "We", "start": 0.1, "end": 0.2, "score": 0.9},
            {"word": "left.", "start": 0.3, "end": 0.6, "score": 0.9},
            {"word": "We", "start": 1.0, "end": 1.2, "score": 0.9},
            {"word": "stayed.", "start": 1.5, "end": 2.5, "score": 0.9},
        ], captions[0])
        self.assertEqual(result, [[12, None, None], [12.3, 12.6, 0.9], [13, 13.2, 0.9], None])

    def test_preserves_native_internal_anchors_and_does_not_accept_interpolated_scores(self):
        words, captions = parse_captions(self.data(), 16)
        words[1]["time"] = None
        result = merge_alignment(words[:4], [
            {"word": "We", "start": 0.1, "end": 0.2, "score": 0.9},
            {"word": "left.", "start": 0.3, "end": 1.0, "score": 0.9},
            {"word": "We", "start": 1.3, "end": 1.5},
            {"word": "stayed.", "start": 1.6, "end": 1.8},
        ], captions[0])
        self.assertIsNone(result[1])  # Would run past the trusted 12.9 anchor.
        self.assertEqual(result[2], [12.9, None, None])

    def test_native_timing_or_discrepancy_does_not_load_models_or_download_audio(self):
        data = self.data()
        data["events"][0]["segs"] = [
            {"utf8": "We left."}, {"utf8": " We", "tOffsetMs": 900},
            {"utf8": " stayed.", "tOffsetMs": 1100},
        ]
        info = {"id": "abcdefghijk", "duration": 16,
                "subtitles": {"en": [{"ext": "json3", "url": "captions"}]}}

        class Downloader:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(self, url, download):
                if download:
                    raise AssertionError("Native word timing must not download audio")
                return info

            def urlopen(self, url):
                return BytesIO(json.dumps(data).encode())

        with patch.dict("sys.modules", {"yt_dlp": SimpleNamespace(YoutubeDL=lambda _: Downloader())}):
            with patch("align.importlib.metadata.version", side_effect=AssertionError("Must not load WhisperX")):
                result = run({"version": 2, "videoId": "abcdefghijk", "sourceHash": "b" * 64,
                              "sentenceStarts": [0, 2, 4],
                              "words": [{"text": word} for word in ["We", "left.", "We", "stayed.", "Next."]]})
                mismatch = run({"version": 2, "videoId": "abcdefghijk", "sourceHash": "b" * 64,
                                "sentenceStarts": [0],
                                "words": [{"text": word} for word in ["Different", "stored", "words."]]})
                unsupported = run({"version": 2, "videoId": "abcdefghijk", "sourceHash": "b" * 64,
                                   "sentenceStarts": [], "words": []})
        self.assertEqual(result["engine"], "youtube-json3")
        self.assertIsNone(result["audioSha256"])
        self.assertEqual(result["wordSources"], ["caption", "unmatched", "youtube", "youtube", "caption"])
        self.assertIsNone(result["words"][1])
        self.assertEqual(mismatch["status"], "transcript-mismatch")
        self.assertEqual((mismatch["expectedWords"], mismatch["actualWords"]), (3, 5))
        self.assertEqual(mismatch["captions"][0]["text"], "We left. We stayed.")
        self.assertNotIn("engine", mismatch)
        self.assertEqual(unsupported["reason"], "format")

    def test_rejects_missing_or_invalid_sentence_start_indices_before_downloading(self):
        with patch.dict("sys.modules", {"yt_dlp": SimpleNamespace(
            YoutubeDL=Mock(side_effect=AssertionError("Invalid requests must not access the network")),
        )}):
            for starts in (None, [], [0, 9], [0, True]):
                with self.subTest(starts=starts):
                    with self.assertRaisesRegex(ValueError, "sentence-start"):
                        run({"version": 2, "videoId": "abcdefghijk", "sourceHash": "b" * 64,
                             "sentenceStarts": starts, "words": [{"text": "We"}, {"text": "left."}]})

    def test_missing_captions_share_one_download_and_decode_only_their_local_intervals(self):
        import numpy as np

        data = {"events": [
            {"tStartMs": 1250, "dDurationMs": 2250, "segs": [{"utf8": "One. Missing."}]},
            {"tStartMs": 3500, "dDurationMs": 1500, "segs": [{"utf8": "More. Missing."}]},
            {"tStartMs": 5000, "dDurationMs": 1000, "segs": [{"utf8": "Still internal."}]},
        ]}
        info = {"id": "abcdefghijk", "duration": 7,
                "subtitles": {"en": [{"ext": "json3", "url": "captions"}]}}
        downloads = []

        class Downloader:
            def __init__(self, settings):
                self.settings = settings

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(inner, url, download):
                if download:
                    self.assertNotIn("download_ranges", inner.settings)
                    self.assertNotIn("force_keyframes_at_cuts", inner.settings)
                    downloads.append(inner.settings)
                    Path(inner.prepare_filename(info)).write_bytes(b"downloaded audio")
                return info

            def prepare_filename(self, section):
                return self.settings["outtmpl"].replace("%(ext)s", "webm")

            def urlopen(self, url):
                return BytesIO(json.dumps(data).encode())

        acoustic = Mock(side_effect=[
            {"word_segments": [{"word": "One."}, {"word": "Missing.", "start": 0.25, "end": 0.5, "score": 0.9}]},
            {"word_segments": [{"word": "More."}, {"word": "Missing.", "start": 0.25, "end": 0.5, "score": 0.9}]},
        ])
        whisperx = SimpleNamespace(load_align_model=Mock(return_value=("model", {})), align=acoustic,
                                   load_audio=Mock(side_effect=AssertionError("Must not decode full audio")))
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False),
                                get_num_threads=lambda: 4, set_num_threads=Mock())
        decoded = [np.zeros(36000, dtype=np.float32), np.zeros(24000, dtype=np.float32)]
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict("sys.modules", {"yt_dlp": SimpleNamespace(
                                            YoutubeDL=Downloader,
                                            utils=SimpleNamespace(download_range_func=Mock())),
                                            "torch": torch, "whisperx": whisperx}):
                with patch("align.importlib.metadata.version", return_value="3.8.6"):
                    with patch("subprocess.run", side_effect=[
                        SimpleNamespace(stdout=audio.tobytes()) for audio in decoded
                    ]) as decode:
                        result = run({"version": 2, "videoId": "abcdefghijk", "sourceHash": "b" * 64,
                                      "workDir": directory, "sentenceStarts": [0, 1, 2, 3, 4],
                                      "words": [{"text": word} for word in
                                                ["One.", "Missing.", "More.", "Missing.", "Still", "internal."]]})
            self.assertEqual(len(downloads), 1)
            self.assertEqual(result["words"], [[1.25, None, None], [1.5, 1.75, 0.9],
                                               [3.5, None, None], [3.75, 4.0, 0.9], [5, None, None], None])
            self.assertEqual(result["wordSources"], ["caption", "acoustic", "caption", "acoustic", "caption", "unmatched"])
            for call, start, duration in zip(decode.call_args_list, [1.25, 3.5], [2.25, 1.5]):
                command = call.args[0]
                self.assertEqual(float(command[command.index("-ss") + 1]), start)
                self.assertEqual(float(command[command.index("-t") + 1]), duration)
                self.assertTrue(command[command.index("-i") + 1].startswith(directory))
                self.assertNotIn("https://", " ".join(command))
                self.assertGreater(call.kwargs["timeout"], 0)
            self.assertFalse(any(Path(directory).iterdir()))
        self.assertEqual(acoustic.call_count, 2)
        for call, duration, audio in zip(acoustic.call_args_list, [2.25, 1.5], decoded):
            self.assertEqual(call.args[0][0]["start"], 0)
            self.assertEqual(call.args[0][0]["end"], duration)
            np.testing.assert_array_equal(call.args[3], audio)

    def test_local_decoder_surfaces_ffmpeg_errors_and_empty_audio(self):
        caption = {"start": 1.25, "end": 3.5}
        failure = subprocess.CalledProcessError(1, ["ffmpeg"], stderr=b"invalid local audio")
        with patch("subprocess.run", side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, "invalid local audio"):
                align.load_caption_audio(Path("audio.webm"), caption)
        with patch("subprocess.run", return_value=SimpleNamespace(stdout=b"")):
            with self.assertRaisesRegex(RuntimeError, "No audio decoded"):
                align.load_caption_audio(Path("audio.webm"), caption)


if __name__ == "__main__":
    unittest.main()
