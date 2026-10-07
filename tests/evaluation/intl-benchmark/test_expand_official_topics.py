import json
import tempfile
import unittest
from pathlib import Path
from expand_official_topics import expand


class OfficialExpansionTest(unittest.TestCase):
    def test_incomplete_official_topic_exclusion_is_explicit_and_auditable(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source';target=Path(directory)/'profile'
            (source/'qrels').mkdir(parents=True)
            (source/'corpus.jsonl').write_text('{"_id":"d1","text":"source"}\n{"_id":"d2","text":"distractor"}\n')
            (source/'queries.jsonl').write_text('{"_id":"q1","text":"valid"}\n{"_id":"q2","text":"invalid"}\n')
            (source/'qrels/test.tsv').write_text('query-id\tcorpus-id\tscore\nq1\td1\t1\nq2\tmissing\t1\n')
            with self.assertRaises(ValueError):expand(source,target,1)
            result=expand(source,target,1,exclude_incomplete=True)
            self.assertEqual(result['excludedTopicCount'],1)
            self.assertEqual(result['corpusDocuments'],2)
            self.assertEqual(result['excludedTopics'][0]['missingPositiveDocuments'],['missing'])
            self.assertFalse(result['leaderboardComparable'])
            self.assertIn('q1\td1\t1.0',(target/'qrels.tsv').read_text())
            self.assertEqual(json.loads((target/'excluded-topics.json').read_text()),result['excludedTopics'])
            self.assertEqual((target/'corpus.jsonl').read_bytes(),(source/'corpus.jsonl').read_bytes())
            self.assertEqual((target/'qrels/test.tsv').read_bytes(),(target/'qrels.tsv').read_bytes())
            self.assertEqual(result['profileCorpusHash'],result['corpusHash'])
