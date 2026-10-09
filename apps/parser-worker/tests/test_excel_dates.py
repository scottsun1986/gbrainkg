"""Excel date cells must render as plain dates unless a real time is present."""
import datetime
import unittest

from structured_excel import _value


class ExcelDateRendering(unittest.TestCase):
    def test_midnight_datetime_renders_as_date_only(self):
        stamp = datetime.datetime(2025, 3, 1, 0, 0, 0)
        self.assertEqual(_value(stamp), "2025-03-01")

    def test_datetime_with_time_keeps_full_iso(self):
        self.assertEqual(_value(datetime.datetime(2025, 3, 1, 9, 30, 0)), "2025-03-01T09:30:00")

    def test_datetime_with_microseconds_keeps_full_iso(self):
        stamp = datetime.datetime(2025, 3, 1, 0, 0, 0, 1)
        self.assertEqual(_value(stamp), "2025-03-01T00:00:00.000001")

    def test_plain_date_and_time_are_unchanged(self):
        self.assertEqual(_value(datetime.date(2025, 3, 1)), "2025-03-01")
        self.assertEqual(_value(datetime.time(9, 30)), "09:30:00")

    def test_non_date_values_pass_through(self):
        self.assertEqual(_value("文本"), "文本")
        self.assertEqual(_value(320.5), 320.5)
        self.assertIsNone(_value(float("nan")))


if __name__ == "__main__":
    unittest.main()