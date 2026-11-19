"""Price table: parsing Claude's pricing page, merging into the JSON, and statusbar lookups."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import statusbar  # noqa: E402
import update_prices  # noqa: E402

PAGE = """## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4.1 ([retired, except on Bedrock](https://example.com)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 3 | $0.25 / MTok | $0.30 / MTok | $0.50 / MTok | $0.03 / MTok | $1.25 / MTok |

| Model | Input | Output |
| ----- | ----- | ------ |
| Claude Fable 5.2 | $16 USD / MTok | $80 USD / MTok |
"""


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.models = update_prices.parse_pricing(PAGE)

    def test_rows_become_model_ids(self):
        self.assertEqual(set(self.models), {"claude-fable-5-2", "claude-opus-5-5", "claude-opus-4-1",
                                            "claude-sonnet-5", "claude-haiku-5-5"})
        self.assertEqual(self.models["claude-fable-5-2"]["input"], 8.0)
        self.assertEqual(self.models["claude-fable-5-2"]["output"], 40.0)  # not the fast-mode table
        self.assertEqual(self.models["claude-sonnet-5"]["input"], 2.0)  # footnote stripped

    def test_retired_and_long_context(self):
        self.assertTrue(self.models["claude-opus-4-1"]["retired"])
        lc = self.models["claude-haiku-5-5"]["long_context"]
        self.assertEqual(lc["threshold"], 100000)
        self.assertEqual(lc["input"], 0.5)
        self.assertEqual(self.models["claude-haiku-5-5"]["input"], 0.1)

    def test_older_than_haiku_3_5_skipped(self):
        self.assertNotIn("claude-3-haiku", self.models)

    def test_merge_keeps_unlisted_and_legacy(self):
        current = {"models": {"claude-opus-4": {"name": "Claude Opus 4", "family": "opus", "version": "4",
                                                "input": 15.0, "output": 75.0}}}
        data = update_prices.merge(current, self.models)
        self.assertFalse(data["models"]["claude-opus-4"]["listed"])
        self.assertTrue(data["models"]["claude-opus-5-5"]["listed"])
        self.assertEqual(data["models"]["claude-3-5-haiku"]["input"], 0.8)
        self.assertEqual(next(iter(data["models"])), "claude-opus-5-5")  # newest first

    def test_refuses_to_write_when_page_unparseable(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "page.md", Path(d) / "prices.json"
            src.write_text("# nothing here\n")
            self.assertEqual(update_prices.main(["--source", str(src), "--out", str(out)]), 2)
            self.assertFalse(out.exists())


class ShippedFileTests(unittest.TestCase):
    def test_covers_haiku_3_5_to_fable_5_2(self):
        models = json.loads((ROOT / "data" / "model-prices.json").read_text())["models"]
        for mid in ("claude-3-5-haiku", "claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5",
                    "claude-fable-5-2"):
            self.assertIn(mid, models)
            self.assertGreater(models[mid]["output"], models[mid]["input"])


class StatusbarLookupTests(unittest.TestCase):
    def test_model_id_normalisation(self):
        cases = {"claude-opus-5-5[1m]": "claude-opus-5-5", "Opus 5.5": "claude-opus-5-5",
                 "claude-opus-4-1-20250805": "claude-opus-4-1", "claude-opus-4-20250514": "claude-opus-4",
                 "claude-3-5-haiku-20241022": "claude-3-5-haiku", "Claude Fable 5.2": "claude-fable-5-2",
                 "claude-sonnet-5": "claude-sonnet-5", "gpt-5": None}
        for name, want in cases.items():
            self.assertEqual(statusbar.claude_model_id(name), want, name)

    def test_uses_json_cache_rates(self):
        cost = statusbar.usage_cost_usd({"cache_read_input_tokens": 1_000_000}, "claude-opus-5-5", {})
        self.assertAlmostEqual(cost, 0.20)  # 0.05x, not the generic 0.1x
        self.assertEqual(statusbar.price_for("claude-fable-5-2", {}), (8.0, 40.0))

    def test_long_context_tier(self):
        short = statusbar.usage_cost_usd({"input_tokens": 100_000}, "claude-haiku-5-5", {})
        long_ = statusbar.usage_cost_usd({"input_tokens": 200_000}, "claude-haiku-5-5", {})
        self.assertAlmostEqual(short, 0.01)
        self.assertAlmostEqual(long_, 0.10)

    def test_config_override_and_fallback(self):
        self.assertEqual(statusbar.price_for("claude-opus-5-5", {"prices": {"opus": [1, 2]}}), (1.0, 2.0))
        self.assertEqual(statusbar.price_for("claude-opus-9-9", {}), statusbar.PRICES["opus"])
        self.assertEqual(statusbar.price_for("gpt-5", {}), statusbar.PRICES["gpt"])


if __name__ == "__main__":
    unittest.main()
