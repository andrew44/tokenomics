"""Both adapters must run the same optimisation logic from the shared engine."""
import unittest
from unittest import mock

from helpers import TempEnv, assistant, user, write_transcript  # noqa: F401  (helpers sets sys.path)

from tokenomics.config import Settings
from tokenomics.engine import classifier, session
from tokenomics.platform.registry import get_adapter


class SameLogicTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.s = Settings(db_path=self.t.db)

    def tearDown(self):
        self.t.cleanup()

    def _claude(self, sid, prompts, tools):
        recs = [user(p) for p in prompts] + [assistant("m1", [(n, i) for n, i in tools])]
        path = write_transcript(self.t.home, sid, recs)
        a = get_adapter("claude-code")
        for p in prompts:
            session.record_prompt(a, {"session_id": sid, "prompt": p, "cwd": "/w"}, self.s)
        session.finalize(a, {"session_id": sid, "cwd": "/w", "hook_event_name": "SessionEnd",
                             "transcript_path": path}, self.s)
        return self.t.session(sid)

    def _copilot(self, sid, prompts, tools):
        a = get_adapter("copilot")
        for p in prompts:
            session.record_prompt(a, {"sessionId": sid, "prompt": p, "cwd": "/w"}, self.s)
        for name, args in tools:
            session.record_tool(a, {"sessionId": sid, "toolName": name, "toolArgs": args, "cwd": "/w"}, self.s)
        session.finalize(a, {"sessionId": sid, "cwd": "/w", "reason": "complete"}, self.s)
        return self.t.session(sid)

    def assertSameResult(self, a, b):
        for k in ("label", "opex_score", "capex_score", "prompt_count", "skills", "skill_opex", "skill_capex"):
            self.assertEqual(a[k], b[k], k)

    def test_capex_session_scores_identically(self):
        prompts = ["implement a new endpoint for the orders api", "now write unit tests"]
        c = self._claude("c1", prompts, [("Edit", {}), ("Write", {})])
        g = self._copilot("g1", prompts, [("edit", {"path": "a.py"}), ("create", {"path": "b.py"})])
        self.assertEqual(c["label"], "capex")
        self.assertSameResult(c, g)

    def test_opex_session_scores_identically(self):
        prompts = ["why is p99 latency up? check the grafana dashboard and loki logs"]
        c = self._claude("c2", prompts, [("Bash", {"command": "kubectl logs api"}), ("mcp__grafana__query", {})])
        g = self._copilot("g2", prompts, [("bash", '{"command": "kubectl logs api"}'),
                                          ("grafana/query", {})])
        self.assertEqual(c["label"], "opex")
        self.assertSameResult(c, g)

    def test_skill_classification_shared(self):
        c = self._claude("c3", ["hi"], [("Skill", {"skill": "grafana-triage"})])
        g = self._copilot("g3", ["hi"], [("skill", {"skill": "grafana-triage"})])
        self.assertEqual(c["skill_opex"], 1)
        self.assertSameResult(c, g)

    def test_changing_shared_logic_changes_both_adapters(self):
        """A change to the shared scorer must reach both platforms (no private copies)."""
        with mock.patch.object(classifier, "OPEX_PATTERNS", [(r"\bbanana\b", 9)]), \
             mock.patch.object(classifier, "CAPEX_PATTERNS", []):
            c = self._claude("c4", ["banana"], [])
            g = self._copilot("g4", ["banana"], [])
        self.assertEqual((c["opex_score"], c["label"]), (9, "opex"))
        self.assertSameResult(c, g)

    def test_adapters_hold_no_scoring_logic(self):
        import tokenomics.adapters.claude_code as cc
        import tokenomics.adapters.copilot as cp
        for mod in (cc, cp):
            for banned in ("OPEX_PATTERNS", "CAPEX_PATTERNS", "label_for", "score", "SKILL_WEIGHT"):
                self.assertFalse(hasattr(mod, banned), f"{mod.__name__} defines {banned}")


class LabelTests(unittest.TestCase):
    def test_label_rules(self):
        self.assertEqual(classifier.label_for(0, 0), "unknown")
        self.assertEqual(classifier.label_for(10, 2), "opex")
        self.assertEqual(classifier.label_for(2, 10), "capex")
        self.assertEqual(classifier.label_for(8, 10), "mixed")

    def test_skill_map_wins(self):
        self.assertEqual(classifier.classify_skill("pdf", None, {"pdf": "opex"}), ("opex", "map"))
        self.assertEqual(classifier.classify_skill("plugin:pdf", None, {"pdf": "capex"}), ("capex", "map"))

    def test_description_decides(self):
        side, basis = classifier.classify_skill("acme", "Create unit tests using NUnit")
        self.assertEqual((side, basis), ("capex", "description"))
        side, basis = classifier.classify_skill("acme", "Analyses App Insights telemetry")
        self.assertEqual((side, basis), ("opex", "description"))


if __name__ == "__main__":
    unittest.main()
