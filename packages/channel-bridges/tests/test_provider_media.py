"""Pure staging helpers: no engine, store, voice backend or provider calls."""
import os
from pathlib import PurePosixPath
import unittest
from unittest.mock import patch

from openagent_channel_bridges.media import (
    attachment_limit_bytes, is_audio_file, safe_attachment_filename,
    safe_attachment_staging_name,
)


class ProviderMediaTests(unittest.TestCase):
    def test_attachment_defaults_and_explicit_instance_environment(self):
        self.assertEqual(attachment_limit_bytes(environment={}), 64 * 1024 * 1024)
        self.assertEqual(attachment_limit_bytes(direction="output", environment={}), 256 * 1024 * 1024)
        # A host-owned empty mapping must not inherit a different process cap.
        with patch.dict(os.environ, {"OPENAGENT_MAX_INBOUND_ATTACHMENT_MB": "2"}):
            self.assertEqual(attachment_limit_bytes(), 2 * 1024 * 1024)
            self.assertEqual(attachment_limit_bytes(environment={}), 64 * 1024 * 1024)

    def test_attachment_zero_negative_invalid_and_output_settings(self):
        key = "OPENAGENT_MAX_INBOUND_ATTACHMENT_MB"
        for value in ("0", "-1"):
            with self.subTest(value=value):
                self.assertEqual(attachment_limit_bytes(environment={key: value}), 0)
        for value in ("", "not-a-size"):
            with self.subTest(value=value):
                self.assertEqual(attachment_limit_bytes(environment={key: value}), 64 * 1024 * 1024)
        self.assertEqual(attachment_limit_bytes(direction="output", environment={"OPENAGENT_MAX_ATTACHMENT_MB": "7"}), 7 * 1024 * 1024)

    def test_filename_strips_paths_and_control_characters(self):
        self.assertEqual(safe_attachment_filename("../../reports/quarter.pdf"), "quarter.pdf")
        self.assertEqual(safe_attachment_filename("C:\\temp\\report\x00\n.pdf"), "report.pdf")
        for value in (None, "", "..", "../..", "/"):
            with self.subTest(value=value):
                self.assertEqual(safe_attachment_filename(value), "attachment")
        self.assertEqual(safe_attachment_filename("", fallback="../../safe.txt"), "safe.txt")

    def test_unicode_filename_is_240_bytes_not_240_characters(self):
        for value in ("界" * 200 + ".pdf", "🙂" * 200 + ".png", "é" * 240 + ".txt"):
            with self.subTest(suffix=value[-4:]):
                result = safe_attachment_filename(value)
                self.assertLessEqual(len(result.encode("utf-8")), 240)
                self.assertTrue(result.endswith(value[-4:]))
                self.assertEqual(PurePosixPath(result).name, result)
                self.assertNotIn("\ufffd", result)

    def test_combined_staging_name_is_bounded_and_preserves_suffix(self):
        result = safe_attachment_staging_name("../" + "識" * 200, "C:\\tmp\\" + "🙂" * 200 + ".pdf")
        self.assertLessEqual(len(result.encode("utf-8")), 240)
        self.assertTrue(result.endswith(".pdf"))
        self.assertNotIn("/", result)
        self.assertNotIn("\\", result)
        self.assertEqual(safe_attachment_staging_name("provider-id", "report.pdf"), "provider-id-report.pdf")

    def test_audio_mime_and_extensions_without_voice_backend(self):
        self.assertTrue(is_audio_file("recording.MP3"))
        self.assertTrue(is_audio_file(None, "audio/ogg"))
        self.assertTrue(is_audio_file("recording.bin", "audio/wav"))
        self.assertFalse(is_audio_file("recording.pdf", "application/pdf"))
        self.assertFalse(is_audio_file(None))
