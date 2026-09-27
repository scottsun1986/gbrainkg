import json
import unittest
from unittest.mock import patch

from profile_300 import BASE, DATASETS, DEV_SOURCE, MAX_DOCS, PROFILE, build, canonical_json, file_hash, list_profile_documents, sha256_bytes, validate_profile_documents, wait_for_status


class Profile300Tests(unittest.TestCase):
    def test_manifest_covers_all_gold_titles_and_is_deterministic(self):
        for dataset in DATASETS:
            with self.subTest(dataset=dataset):
                first = build(dataset)
                second = build(dataset)
                self.assertEqual(first, second)
                selected = json.loads((PROFILE / f"{dataset}_corpus.json").read_text())
                questions = json.loads((BASE / f"{dataset}_eval_set.json").read_text())
                titles = {item["title"].casefold() for item in selected}
                gold = {title.casefold() for question in questions for title in question["gold_titles"]}
                self.assertEqual(len(selected), MAX_DOCS)
                self.assertTrue(gold <= titles)
                self.assertEqual(first["gold_documents"], len(gold))
                self.assertEqual(first["negative_documents"], MAX_DOCS - len(gold))
                self.assertEqual(first["selected_corpus_sha256"], sha256_bytes(canonical_json(selected)))
                self.assertEqual(first["output_file_sha256"], file_hash(PROFILE / f"{dataset}_corpus.json"))
                self.assertEqual(first["dev_source_sha256"], file_hash(BASE / "data" / DEV_SOURCE[dataset]))
                self.assertEqual(first["prep_data_sha256"], file_hash(BASE / "prep_data.py"))
                self.assertNotEqual(first["kb_name"], __import__("ingest_corpus").KB_NAMES[dataset])

    def test_ingest_validation_rejects_missing_extra_and_unpublished_documents(self):
        expected = {f"doc-{index}" for index in range(MAX_DOCS)}
        valid = [{"title": title, "status": "published"} for title in sorted(expected)]
        validate_profile_documents(valid, expected, require_published=True)
        with self.assertRaisesRegex(RuntimeError, "count=299"):
            validate_profile_documents(valid[:-1], expected, require_published=True)
        with self.assertRaisesRegex(RuntimeError, "extra="):
            validate_profile_documents(valid[:-1] + [{"title": "unexpected", "status": "published"}], expected, True)
        with self.assertRaisesRegex(RuntimeError, "unpublished="):
            validate_profile_documents(valid[:-1] + [{"title": valid[-1]["title"], "status": "failed"}], expected, True)

    def test_waits_for_whole_kb_published_counts_before_listing_pages(self):
        pending = {"total": MAX_DOCS, "published": 299, "processing": 1}
        finished = {"total": MAX_DOCS, "published": MAX_DOCS, "processing": 0}
        with patch("profile_300.profile_status_counts", side_effect=[pending, finished]) as status, \
             patch("profile_300.time.sleep") as sleep:
            self.assertEqual(wait_for_status("token", "kb", published=True, timeout_s=10), finished)
            self.assertEqual(status.call_count, 2)
            sleep.assert_called_once()

    def test_rejects_offset_page_drift_before_inferring_missing_titles(self):
        documents = [{"id": f"d-{index}", "title": f"doc-{index}"} for index in range(MAX_DOCS)]
        documents[-1] = dict(documents[0])
        with patch("profile_300.api.list_all_docs", return_value=documents):
            with self.assertRaisesRegex(RuntimeError, "unstable document pagination"):
                list_profile_documents("token", "kb", {"total": MAX_DOCS})


if __name__ == "__main__":
    unittest.main()
