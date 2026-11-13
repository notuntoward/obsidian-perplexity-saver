import unittest
from unittest.mock import patch
from io import BytesIO
import json
from types import SimpleNamespace

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

    def test_complete_native_timing_does_not_load_models_or_download_audio(self):
        data = self.data()
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
                              "words": [{"text": word} for word in ["We", "left.", "We", "stayed.", "Next."]]})
        self.assertEqual(result["engine"], "youtube-json3")
        self.assertIsNone(result["audioSha256"])
        self.assertEqual(result["wordSources"], ["caption", "youtube", "youtube", "youtube", "caption"])


if __name__ == "__main__":
    unittest.main()
