"""The standalone scripts: coach, dashboard, handoff, statusbar, pennywise."""
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path

from helpers import ROOT, TempEnv, assistant, user, write_transcript

SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import dashboard  # noqa: E402
import handoff  # noqa: E402
import pennywise  # noqa: E402
import statusbar  # noqa: E402


class ImportTests(unittest.TestCase):
    def test_every_module_imports_on_its_own(self):
        """No import cycles: each module must load first, in a fresh interpreter."""
        mods = []
        for p in sorted((ROOT / "tokenomics").rglob("*.py")):
            parts = p.relative_to(ROOT).with_suffix("").parts
            mods.append(".".join(parts[:-1] if parts[-1] == "__init__" else parts))
        for m in mods:
            r = subprocess.run([sys.executable, "-c", f"import {m}"], cwd=ROOT,
                               capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, f"{m}: {r.stderr}")


class CoachTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def test_runs_and_scores_topics(self):
        path = write_transcript(self.t.home, "cf", [
            user("write a python function and add unit tests for the api"),
            assistant("m1"),
            user("implement a new endpoint class in the service and refactor the code"),
            assistant("m2"),
            user("why is p99 latency up in grafana? check the loki logs"),
            assistant("m3"),
            user("check the grafana dashboard metrics and alerts"),
            assistant("m4"),
        ])
        r = subprocess.run([sys.executable, str(SCRIPTS / "coach.py"), "--transcript", path, "--json"],
                           capture_output=True, text=True, env=self.t.env(), timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["prompts"], 4)
        self.assertEqual(out["prompt_stats"]["leaning"], {"capex": 2, "opex": 2})
        self.assertIn("mixed_topics_in_one_session", out["flags"])


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def test_demo_seed_and_build(self):
        dashboard.seed_demo(self.t.db)
        data = dashboard.build(self.t.db, 30)
        self.assertFalse(data["empty"])
        self.assertEqual(len(data["daily"]), 30)
        self.assertGreater(sum(v["sessions"] for v in data["totals"].values()), 0)

    def test_all_time_with_undated_rows_only(self):
        from tokenomics.engine import store
        db = store.connect(self.t.db)
        db.execute("INSERT INTO sessions(session_id, label) VALUES('x', 'opex')")
        db.commit()
        db.close()
        data = dashboard.build(self.t.db, 0)
        self.assertEqual(data["totals"]["opex"]["sessions"], 1)
        self.assertEqual(data["daily"], [])

    def test_missing_db(self):
        self.assertEqual(dashboard.build(str(self.t.home / "nope.db"), 30)["reason"], "no-database")


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.old_dir = handoff.OUT_DIR
        handoff.OUT_DIR = self.t.home / "handoffs"
        handoff.OUT_DIR.mkdir()

    def tearDown(self):
        handoff.OUT_DIR = self.old_dir
        self.t.cleanup()

    def _meta(self, **kw):
        md = handoff.OUT_DIR / "old.md"
        md.write_text("# Handoff")
        meta = {"session_id": "old", "cwd": "/w", "written": time.time(), "path": str(md)}
        meta.update(kw)
        (handoff.OUT_DIR / "old.json").write_text(json.dumps(meta))

    def test_start_notice(self):
        self._meta(handoff_tokens=900, ctx_tokens=150000)
        out = handoff.start({"session_id": "new", "cwd": "/w", "source": "startup"})
        self.assertIn("about 900 tokens vs 150,000", out["systemMessage"])

    def test_start_notice_without_token_counts(self):
        self._meta()
        out = handoff.start({"session_id": "new", "cwd": "/w", "source": "startup"})
        self.assertIn("about ? tokens vs ?", out["systemMessage"])

    def test_copilot_prefers_own_session_transcript(self):
        root = self.t.home / "session-state"
        for sid in ("mine", "other"):
            (root / sid).mkdir(parents=True)
            (root / sid / "events.jsonl").write_text("{}\n")
            time.sleep(0.02)                              # "other" is newer
        p = handoff.resolve_transcript({"sessionId": "mine", "transcript_path": str(root)}, "copilot")
        self.assertEqual(p.parent.name, "mine")
        p = handoff.resolve_transcript({"transcript_path": str(root)}, "copilot")
        self.assertEqual(p.parent.name, "other")

    def test_digest(self):
        path = write_transcript(self.t.home, "h", [
            user("add a login page"),
            assistant("m1", [("Edit", {"file_path": "/w/login.py"}), ("Bash", {"command": "pytest -q"})]),
        ])
        r = handoff.digest(path)
        self.assertEqual((r["prompts"], r["files"], r["cmds"]), (["add a login page"], ["/w/login.py"], ["pytest -q"]))


class StatusbarTests(unittest.TestCase):
    def test_most_specific_price_wins(self):
        cfg = {"prices": {"opus": [9, 90], "claude-opus-4-6": [6, 30]}}
        r = statusbar.rates_for("claude-opus-4-6", cfg)
        self.assertEqual((r["input"], r["output"]), (6.0, 30.0))
        self.assertAlmostEqual(r["cache_read"], 0.6)
        self.assertEqual(statusbar.rates_for("claude-opus-4-7", cfg)["input"], 9.0)   # only the family override matches
        self.assertEqual(statusbar.price_for("mystery", {}), statusbar.DEFAULT_PRICE)

    def test_gather_accepts_string_model(self):
        info = statusbar.gather({"model": "gpt-5", "context_window": {"used_percentage": 40}},
                                dict(statusbar.DEFAULT_CFG), {})
        self.assertEqual((info["model"], info["pct"]), ("gpt-5", 40.0))

    def test_live_transcript_survives_cache_trim(self):
        t = TempEnv()
        try:
            state = {"transcripts": {f"/old/{i}.jsonl": {"offset": 10 ** 9, "seen": i} for i in range(20)}}
            path = write_transcript(t.home, "live", [assistant("m1")])
            statusbar.scan_transcript(path, state, dict(statusbar.DEFAULT_CFG))
            self.assertIn(path, state["transcripts"])
            self.assertEqual(len(state["transcripts"]), 20)
        finally:
            t.cleanup()

    def test_render_plain(self):
        cfg = dict(statusbar.DEFAULT_CFG)
        info = {"model": "Sonnet", "total": 12_300, "cost": 1.5, "symbol": "£", "estimated": True,
                "pct": 50, "ttl": 300, "remaining": 90}
        line = statusbar.render(info, statusbar.Style("dark", color=False, ascii_only=True), cfg)
        self.assertEqual(line, "* Sonnet | ctx ######------ 50% | tok 12.3K | ~£1.50 | [# ] 01:30")


class PennywiseTests(unittest.TestCase):
    def test_rate(self):
        self.assertEqual(pennywise.rate("create a hello world console app")[0], 1)
        self.assertIsNone(pennywise.rate("design the architecture for a distributed queue")[0])
        self.assertIsNone(pennywise.rate("```\ncode\n```")[0])

    def test_tier_of(self):
        self.assertEqual([pennywise.tier_of(m) for m in ("claude-haiku-x", "Sonnet", "opus", "gpt-5")],
                         [1, 2, 3, None])


if __name__ == "__main__":
    unittest.main()
