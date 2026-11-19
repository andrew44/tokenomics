"""Pricing, budget, diet and the spend report."""
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

from helpers import ROOT, TempEnv, assistant, user, write_transcript

from tokenomics.config import Settings
from tokenomics.engine import budget, diet, pricing, session, store
from tokenomics.engine.evidence import TOOL_READ, TOOL_SHELL, TokenUsage, ToolCall
from tokenomics.platform.registry import get_adapter

SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import report  # noqa: E402
import statusbar  # noqa: E402

SONNET = {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_creation_input_tokens": 0,
          "cache_read_input_tokens": 0}


def sonnet_msg(mid, usage=SONNET):
    rec = assistant(mid, usage=usage)
    rec["message"]["model"] = "claude-sonnet-5-5"
    return rec


class PricingTests(unittest.TestCase):
    def test_matches_statusbar(self):
        """statusbar.py keeps its own copy of the table (it is installed as a single file)."""
        self.assertEqual(pricing.PRICES, statusbar.PRICES)
        self.assertEqual(pricing.DEFAULT_PRICE, statusbar.DEFAULT_PRICE)
        raw = {"input_tokens": 1000, "output_tokens": 500, "cache_creation_input_tokens": 3000,
               "cache_read_input_tokens": 9000, "cache_creation": {"ephemeral_1h_input_tokens": 1000,
                                                                     "ephemeral_5m_input_tokens": 2000}}
        tu = TokenUsage(1000, 500, 3000, 9000, cache_creation_1h_tokens=1000)
        for model in ("claude-opus-4-6", "claude-haiku", "mystery"):
            self.assertAlmostEqual(pricing.usage_cost_usd(tu, model, pricing.PRICES),
                                   statusbar.usage_cost_usd(raw, model, {}))

    def test_usd_gbp_env(self):
        with mock.patch.dict(os.environ, {"TOKENOMICS_USD_GBP": "0.5", "TOKENOMICS_HOME": "/nonexistent"}):
            self.assertEqual(pricing.usd_gbp(), 0.5)


class CostRecordingTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.s = Settings(db_path=self.t.db)
        self.cc = get_adapter("claude-code")

    def tearDown(self):
        self.t.cleanup()

    def _finalize(self, records):
        path = write_transcript(self.t.home, "c1", records)
        session.finalize(self.cc, {"session_id": "c1", "transcript_path": path, "hook_event_name": "Stop"}, self.s)

    def test_cost_and_daily_increments(self):
        self._finalize([user("hi"), sonnet_msg("m1")])
        r = self.t.session("c1")
        self.assertEqual(r["model"], "claude-sonnet-5-5")
        self.assertAlmostEqual(r["cost_usd"], 3.0 + 1.5)                 # 1M in @3 + 0.1M out @15
        self._finalize([user("hi"), sonnet_msg("m1"), sonnet_msg("m2")])  # one more turn
        self.assertAlmostEqual(self.t.session("c1")["cost_usd"], 9.0)
        events = self.t.rows("SELECT usd FROM cost_events WHERE session_id='c1' ORDER BY id")
        self.assertEqual([round(e["usd"], 2) for e in events], [4.5, 4.5])
        self._finalize([user("hi"), sonnet_msg("m1"), sonnet_msg("m2")])  # nothing new: no event
        self.assertEqual(len(self.t.rows("SELECT * FROM cost_events")), 2)

    def test_model_switch_priced_per_model(self):
        opus = assistant("m2", usage=SONNET)
        opus["message"]["model"] = "claude-opus-4-6"
        self._finalize([user("hi"), sonnet_msg("m1"), opus])
        self.assertAlmostEqual(self.t.session("c1")["cost_usd"], 4.5 + 7.5)

    def test_copilot_never_priced(self):
        cp = get_adapter("copilot")
        session.record_prompt(cp, {"sessionId": "g", "prompt": "add a cli"}, self.s)
        session.finalize(cp, {"sessionId": "g"}, self.s)
        self.assertIsNone(self.t.session("g")["cost_usd"])
        self.assertEqual(self.t.rows("SELECT * FROM cost_events"), [])


class DietRuleTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        (self.t.home / "package-lock.json").write_text("x" * 200_000)
        (self.t.home / "small.lock").write_text("x")
        (self.t.home / "app.log").write_text("x" * 200_000)
        (self.t.home / "app.py").write_text("x" * 200_000)

    def tearDown(self):
        self.t.cleanup()

    def shell(self, cmd):
        v = diet.check(ToolCall("Bash", TOOL_SHELL, command=cmd), str(self.t.home))
        return v.rule if v else None

    def test_shell_rules(self):
        cases = {
            "kubectl logs api-7f9": "unbounded-logs",
            "kubectl -n prod logs api": "unbounded-logs",
            "kubectl logs api --tail=200": None,
            "kubectl logs api --since 10m": None,
            "kubectl logs api | grep ERROR": None,
            "kubectl logs api > /tmp/api.log": None,
            "docker logs web": "unbounded-logs",
            "docker logs -n 50 web": None,
            "docker compose logs": "unbounded-logs",
            "journalctl -u nginx": "unbounded-logs",
            "journalctl -u nginx -n 100": None,
            "git log": "unbounded-git-log",
            "cd repo && git log -p": "unbounded-git-log",
            "git log --oneline -20": None,
            "git log -n5": None,
            "git log main..feature": None,
            "git status && git diff": None,
            "find / -name '*.conf'": "unbounded-find",
            "find / -maxdepth 2 -name x": None,
            "find . -name '*.py'": None,
            "ls -laR": "recursive-listing",
            "ls -la": None,
            "tree": "recursive-listing",
            "tree -L 2": None,
            "cat app.log": "large-cat",
            "sudo cat package-lock.json": "large-cat",
            "cat small.lock": None,
            "cat missing.txt": None,
            "cat app.log # diet-ok": None,
            "head -50 app.log": None,
            "echo 'unterminated": None,
            "": None,
        }
        for cmd, want in cases.items():
            with self.subTest(cmd=cmd):
                self.assertEqual(self.shell(cmd), want)

    def test_read_rules(self):
        def read(name, ranged=False):
            v = diet.check(ToolCall("Read", TOOL_READ, path=name, ranged=ranged), str(self.t.home))
            return v.rule if v else None
        self.assertEqual(read(str(self.t.home / "package-lock.json")), "generated-file")
        self.assertIsNone(read(str(self.t.home / "package-lock.json"), ranged=True))
        self.assertIsNone(read(str(self.t.home / "app.py")))             # big but hand-written: Claude caps it
        self.assertIsNone(read(str(self.t.home / "small.lock")))
        self.assertIsNone(read(str(self.t.home / "nope.min.js")))
        with mock.patch.dict(os.environ, {"TOKENOMICS_DIET_MAX_KB": "1000"}):
            self.assertIsNone(read(str(self.t.home / "package-lock.json")))

    def test_adapters_map_reads(self):
        cc, cp = get_adapter("claude-code"), get_adapter("copilot")
        a = cc.tool_call({"tool_name": "Read", "tool_input": {"file_path": "/x/a", "limit": 10}})
        self.assertEqual((a.kind, a.path, a.ranged), (TOOL_READ, "/x/a", True))
        b = cp.tool_call({"toolName": "view", "toolArgs": json.dumps({"path": "/x/a"})})
        self.assertEqual((b.kind, b.path, b.ranged), (TOOL_READ, "/x/a", False))
        c = cp.tool_call({"toolName": "str_replace_editor", "toolArgs": {"command": "view", "path": "/x/a",
                                                                         "view_range": [1, 20]}})
        self.assertEqual((c.kind, c.ranged), (TOOL_READ, True))


class DietHookTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def run_hook(self, source, payload, **env):
        data = payload if isinstance(payload, str) else json.dumps(payload)
        p = subprocess.run([sys.executable, str(SCRIPTS / "diet.py"), source], input=data, capture_output=True,
                           text=True, env=self.t.env(**env), timeout=30)
        self.assertEqual((p.returncode, p.stderr), (0, ""))
        return json.loads(p.stdout) if p.stdout.strip() else None

    def test_claude_deny_and_log(self):
        out = self.run_hook("claude-code", {"session_id": "s", "tool_name": "Bash",
                                            "tool_input": {"command": "kubectl logs api"}})
        hso = out["hookSpecificOutput"]
        self.assertEqual((hso["hookEventName"], hso["permissionDecision"]), ("PreToolUse", "deny"))
        self.assertIn("--tail", hso["permissionDecisionReason"])
        self.assertEqual(self.t.rows("SELECT session_id, rule, action FROM diet_events"),
                         [{"session_id": "s", "rule": "unbounded-logs", "action": "denied"}])

    def test_copilot_deny(self):
        out = self.run_hook("copilot", {"sessionId": "g", "toolName": "bash",
                                        "toolArgs": json.dumps({"command": "git log"})})
        self.assertEqual(out["permissionDecision"], "deny")

    def test_modes_and_bad_input(self):
        bad = {"session_id": "s", "tool_name": "Bash", "tool_input": {"command": "git log"}}
        self.assertEqual(set(self.run_hook("claude-code", bad, TOKENOMICS_DIET="warn")), {"systemMessage"})
        self.assertIsNone(self.run_hook("claude-code", bad, TOKENOMICS_DIET="off"))
        self.assertIsNone(self.run_hook("claude-code", {"tool_name": "Bash", "tool_input": {"command": "ls"}}))
        for payload in ("", "nope", "[1]", "{}"):
            for src in ("claude-code", "copilot", "other"):
                self.assertIsNone(self.run_hook(src, payload))


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.db = store.connect(self.t.db)
        self.env = mock.patch.dict(os.environ, {"TOKENOMICS_USD_GBP": "1", "TOKENOMICS_HOME": str(self.t.home)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.db.close()
        self.t.cleanup()

    def spend(self, sid, usd):
        store.upsert(self.db, sid, "claude-code", None, 0, 0, 1, False, lambda o, c: "unknown")
        store.set_cost(self.db, sid, usd, "claude-sonnet")

    def check(self, sid, prompt, **kw):
        return budget.check(self.db, sid, prompt, budget.Limits(**kw))

    def test_inactive_without_limits(self):
        self.spend("a", 100)
        self.assertIsNone(self.check("a", "hi"))

    def test_warn_then_block_then_override(self):
        self.spend("a", 8.5)
        d = self.check("a", "next", daily_gbp=10)
        self.assertEqual(d.action, "warned")
        self.assertIn("85%", d.message)
        self.assertIsNone(self.check("a", "again", daily_gbp=10))          # warned once only
        self.spend("a", 10.5)
        d = self.check("a", "do the thing", daily_gbp=10)
        self.assertEqual(d.action, "blocked")
        self.assertIn("£10.50", d.message)
        self.assertEqual(self.check("a", "something else", daily_gbp=10).action, "blocked")
        self.assertIsNone(self.check("a", "something else", daily_gbp=10))  # same prompt again = carry on
        self.assertIsNone(self.check("a", "more", daily_gbp=10))            # not paused again today

    def test_prefix_bypass_and_daily_sums_sessions(self):
        self.spend("a", 6)
        self.spend("b", 6)
        self.assertEqual(self.check("c", "hi", daily_gbp=10).action, "blocked")
        self.assertIsNone(self.check("c", "over-budget: hi", daily_gbp=10))

    def test_session_limit_is_per_session(self):
        self.spend("a", 6)
        self.assertEqual(self.check("a", "hi", session_gbp=5).action, "blocked")
        self.assertIsNone(self.check("b", "hi", session_gbp=5))

    def test_warn_mode_never_blocks(self):
        self.spend("a", 20)
        d = self.check("a", "hi", daily_gbp=10, mode="warn")
        self.assertEqual(d.action, "warned")
        self.assertNotIn("same prompt again", d.message)
        self.assertIsNone(self.check("a", "hi", daily_gbp=10, mode="warn"))

    def test_hook_end_to_end(self):
        self.spend("a", 50)
        self.db.commit()
        payload = json.dumps({"session_id": "a", "prompt": "hi"})
        run = lambda src, **e: subprocess.run([sys.executable, str(SCRIPTS / "budget.py"), src],  # noqa: E731
                                              input=payload, capture_output=True, text=True, timeout=30,
                                              env=self.t.env(TOKENOMICS_USD_GBP="1", **e))
        self.assertEqual(run("claude-code").stdout, "")                         # no limit set
        out = json.loads(run("claude-code", TOKENOMICS_BUDGET_DAILY="10").stdout)
        self.assertEqual(out["decision"], "block")
        self.assertEqual(run("copilot", TOKENOMICS_BUDGET_DAILY="10").stdout, "")  # cannot block there
        st = subprocess.run([sys.executable, str(SCRIPTS / "budget.py"), "status"], capture_output=True,
                            text=True, timeout=30, env=self.t.env(TOKENOMICS_USD_GBP="1"))
        self.assertIn("Spent today: £50.00", st.stdout)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def test_empty(self):
        r = report.build(str(self.t.home / "none.db"), 7, usd_gbp=1)
        self.assertEqual(r["reason"], "no-database")
        self.assertIn("No database", report.markdown(r))

    def test_full_report(self):
        s = Settings(db_path=self.t.db)
        cc = get_adapter("claude-code")
        path = write_transcript(self.t.home, "r1", [user("write a python function and unit tests for the api"),
                                                     sonnet_msg("m1")])
        session.finalize(cc, {"session_id": "r1", "cwd": "/work/api", "transcript_path": path,
                              "hook_event_name": "SessionEnd"}, s)
        p = subprocess.run([sys.executable, str(SCRIPTS / "diet.py"), "claude-code"], timeout=30,
                           input=json.dumps({"session_id": "r1", "tool_name": "Bash",
                                             "tool_input": {"command": "git log"}}),
                           capture_output=True, text=True, env=self.t.env())
        self.assertEqual(p.returncode, 0)
        r = report.build(self.t.db, 7, usd_gbp=1)
        self.assertFalse(r["empty"])
        self.assertEqual(r["spend_gbp"], 4.5)
        self.assertEqual(r["by_label"]["capex"]["sessions"], 1)
        self.assertEqual(r["by_project"][0]["project"], "api")
        self.assertEqual(r["top_sessions"][0]["model"], "claude-sonnet-5-5")
        self.assertEqual(r["helpers"]["diet"][0]["rule"], "unbounded-git-log")
        md = report.markdown(r)
        self.assertIn("**Spend: £4.50**", md)
        self.assertIn("unbounded-git-log x1", md)
        p = subprocess.run([sys.executable, str(SCRIPTS / "report.py"), "--json", "--days", "0"],
                           capture_output=True, text=True, env=self.t.env(), timeout=30)
        self.assertEqual(json.loads(p.stdout)["days"], 0)


class WiringTests(unittest.TestCase):
    def test_new_hooks_and_skill_wired(self):
        cc = (ROOT / "hooks" / "hooks.json").read_text()
        cp = json.loads((ROOT / "copilot-hooks.json").read_text())
        hooks = json.loads(cc)["hooks"]
        self.assertEqual(hooks["PreToolUse"][0]["matcher"], "Read|Bash")
        self.assertIn("diet.py", cc)
        self.assertTrue(any("budget.py" in h["command"] for g in hooks["UserPromptSubmit"] for h in g["hooks"]))
        self.assertIn("diet.py copilot", cp["hooks"]["preToolUse"][0]["bash"])
        self.assertTrue((ROOT / "skills" / "spend-report" / "SKILL.md").is_file())


if __name__ == "__main__":
    unittest.main()
