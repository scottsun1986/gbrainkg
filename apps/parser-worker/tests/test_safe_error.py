"""Parser failures must report an actionable message without leaking internals."""
import unittest
import zipfile

import main


class SafeErrorMessages(unittest.TestCase):
    def test_corrupt_container_is_reported_as_corrupt_file(self):
        message = main.safe_error(zipfile.BadZipFile("File is not a zip file"))
        self.assertIn("损坏", message)
        self.assertNotIn("BadZipFile", message)

    def test_encrypted_file_is_reported_as_protected(self):
        self.assertIn("加密", main.safe_error(PermissionError("File has been decrypted")))

    def test_undecodable_bytes_report_encoding_problem(self):
        error = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")
        self.assertIn("编码", main.safe_error(error))

    def test_unknown_errors_never_expose_internal_detail(self):
        message = main.safe_error(RuntimeError("provider 401 https://api.example.com?key=secret"))
        self.assertNotIn("secret", message)
        self.assertNotIn("api.example.com", message)
        self.assertIn("解析失败", message)

    def test_reviewed_budget_messages_are_preserved_verbatim(self):
        self.assertEqual(main.safe_error(ValueError("Image exceeds configured limit")), "Image exceeds configured limit")
        self.assertEqual(
            main.safe_error(RuntimeError("Parser returned only scaffolding for this document")),
            "Parser returned only scaffolding for this document",
        )


if __name__ == "__main__":
    unittest.main()