import unittest
from transcribe import words_from_whisper


class WordsFromWhisper(unittest.TestCase):
    def doc(self, *segs):
        return {"transcription": [{"text": t, "offsets": {"from": a, "to": b}} for t, a, b in segs]}

    def test_words_in_seconds_with_spacing_for_gaps(self):
        w = words_from_whisper(self.doc((" hello", 0, 400), (" world", 900, 1300)))
        self.assertEqual([x["type"] for x in w], ["word", "spacing", "word"])
        self.assertEqual(w[0], {"text": "hello", "start": 0.0, "end": 0.4, "type": "word", "speaker_id": "speaker_0"})
        self.assertEqual((w[1]["start"], w[1]["end"]), (0.4, 0.9))

    def test_no_spacing_between_touching_words(self):
        w = words_from_whisper(self.doc(("a", 0, 100), ("b", 100, 200)))
        self.assertEqual([x["type"] for x in w], ["word", "word"])

    def test_bracketed_non_speech_and_empty_segments_are_not_words(self):
        w = words_from_whisper(self.doc(("[BLANK_AUDIO]", 0, 2000), ("  ", 2000, 2100), ("go", 2100, 2400)))
        self.assertEqual([x["text"] for x in w], ["go"])

    def test_every_word_is_speaker_0_because_there_is_no_diarization(self):
        w = words_from_whisper(self.doc(("a", 0, 1), ("b", 5, 9)))
        self.assertEqual({x["speaker_id"] for x in w}, {"speaker_0"})


if __name__ == "__main__":
    unittest.main()
