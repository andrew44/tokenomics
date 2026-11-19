"""Pricing, budget, diet and the spend report."""
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

from helpers import ROOT, TempEnv, assistant, user, write_transcript

from tokenomics.config import Settings
from tokenomics.engine import budget, currency, diet, pricing, session, store
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
    def test_engine_and_statusbar_agree_for_every_model(self):
        """statusbar.py keeps its own copy of the lookup (it is installed as a single file)."""
        models = list(json.loads((ROOT / "data" / "model-prices.json").read_text())["models"])
        names = models + ["claude-opus-4-1-20250805", "Opus 5.5", "claude-opus-5-5[1m]", "gpt-5", "mystery",
                          "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-haiku-5-5"]
        cfgs = [{}, {"prices": {"claude-opus-5-5": [3, 15, 0.1], "haiku": [1, 2]}}]
        for fast in (False, True):
            for big in (False, True):
                raw = {"input_tokens": 1000 + (200_000 if big else 0), "output_tokens": 500,
                       "cache_creation_input_tokens": 3000, "cache_read_input_tokens": 9000,
                       "cache_creation": {"ephemeral_1h_input_tokens": 1000, "ephemeral_5m_input_tokens": 2000},
                       "speed": "fast" if fast else "standard"}
                tu = TokenUsage(raw["input_tokens"], 500, 3000, 9000, cache_creation_1h_tokens=1000, fast=fast)
                for model in names:
                    for cfg in cfgs:
                        with self.subTest(model=model, fast=fast, big=big, cfg=bool(cfg)):
                            self.assertAlmostEqual(pricing.usage_cost_usd(tu, model, cfg),
                                                   statusbar.usage_cost_usd(raw, model, cfg))

    def test_versions_priced_separately(self):
        cases = {
            "claude-fable-5-2": (8, 40, 0.20), "claude-mythos-5-2": (8, 40, 0.20),
            "claude-fable-5-1": (10, 50, 0.25), "claude-fable-5": (10, 50, 1.00),
            "claude-fable-5-20260101": (10, 50, 1.00),                     # a date is not version 5.2
            "claude-opus-5-5": (4, 20, 0.20), "claude-opus-5": (5, 25, 0.50), "claude-opus-4-8": (5, 25, 0.50),
            "claude-opus-4-1-20250805": (15, 75, 1.50), "claude-opus-4-20250514": (15, 75, 1.50),
            "claude-opus-4-5@20251101": (5, 25, 0.50), "claude-sonnet-5-5": (2, 10, 0.10),
            "claude-sonnet-5": (2, 10, 0.20), "us.anthropic.claude-sonnet-4-5-20250929-v1:0": (3, 15, 0.30),
            "claude-haiku-5-5": (0.10, 0.50, 0.01), "claude-haiku-4-5-20251001": (1, 5, 0.10),
            "claude-3-5-haiku-20241022": (0.80, 4, 0.08), "Opus 4.8": (5, 25, 0.50),
            "Sonnet 5.5": (2, 10, 0.10), "claude-opus-5-5[1m]": (4, 20, 0.20),
        }
        for model, (pin, pout, pread) in cases.items():
            with self.subTest(model=model):
                r = pricing.rates_for(model, {})
                self.assertEqual((r["input"], r["output"]), (float(pin), float(pout)))
                self.assertAlmostEqual(r["cache_read"], pread)

    def test_fallbacks_for_unlisted_models(self):
        self.assertEqual(pricing.rates_for("gpt-5", {})["input"], 2.5)
        self.assertEqual(pricing.rates_for("claude-opus-9-9", {})["input"], 5.0)      # family fallback
        r = pricing.rates_for("mystery", {})
        self.assertEqual((r["input"], r["output"]), pricing.DEFAULT_PRICE)

    def test_long_prompt_tier_fast_mode_and_overrides(self):
        self.assertAlmostEqual(pricing.usage_cost_usd(TokenUsage(input_tokens=1_000_000), "claude-haiku-5-5", {}), 0.50)
        self.assertAlmostEqual(pricing.usage_cost_usd(TokenUsage(input_tokens=100_000), "claude-haiku-5-5", {}), 0.01)
        fast = TokenUsage(input_tokens=1_000_000, fast=True)
        self.assertAlmostEqual(pricing.usage_cost_usd(fast, "claude-opus-5-5", {}), 8.0)
        r = pricing.rates_for("claude-opus-5-5", {"prices": {"opus-5-5": [3, 15, 0.1]}})
        self.assertEqual((r["input"], r["output"], r["cache_read"]), (3.0, 15.0, 0.1))
        r = pricing.rates_for("claude-opus-5-5", {"prices": {"opus": [1, 2], "opus-5-5": [3, 15]}})
        self.assertEqual(r["input"], 3.0)                                 # most specific override wins
        cache = TokenUsage(cache_creation_tokens=1_000_000, cache_creation_1h_tokens=400_000,
                           cache_read_tokens=1_000_000)
        self.assertAlmostEqual(pricing.usage_cost_usd(cache, "claude-fable-5-2", {}),
                               0.6 * 10 + 0.4 * 16 + 0.20)                # the file's own cache-write prices


class CurrencyTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"TOKENOMICS_HOME": "/nonexistent"})
        self.env.start()
        for k in ("TOKENOMICS_CURRENCY", "TOKENOMICS_USD_GBP", "TOKENOMICS_USD_EUR"):
            os.environ.pop(k, None)

    def tearDown(self):
        self.env.stop()

    def test_block_matches_statusbar(self):
        def block(path):
            text = path.read_text(encoding="utf-8")
            start = text.index("\n", text.index("# BEGIN CURRENCY")) + 1
            return text[start:text.index("# END CURRENCY")]
        self.assertEqual(block(ROOT / "tokenomics" / "engine" / "currency.py"), block(SCRIPTS / "statusbar.py"))

    def test_choice_and_aliases(self):
        self.assertEqual(currency.current(), ("GBP", "£", 0.76))                # default unchanged
        for spelling, code in (("usd", "USD"), ("$", "USD"), ("Euro", "EUR"), ("€", "EUR"), ("£", "GBP"),
                               (" pounds ", "GBP"), ("yen", None), ("", None)):
            self.assertEqual(currency.currency_code(spelling), code, spelling)
        self.assertEqual(currency.current({"currency": "eur"}), ("EUR", "€", 0.86))
        self.assertEqual(currency.current({"currency": "USD", "usd_gbp": 0.5}), ("USD", "$", 1.0))
        self.assertEqual(currency.current({"currency": "nonsense"})[0], "GBP")

    def test_env_beats_config_and_rates(self):
        with mock.patch.dict(os.environ, {"TOKENOMICS_CURRENCY": "EUR", "TOKENOMICS_USD_EUR": "0.9"}):
            self.assertEqual(currency.current({"currency": "USD", "usd_eur": 0.8}), ("EUR", "€", 0.9))
        self.assertEqual(currency.current({"currency": "EUR", "usd_eur": 0.8}), ("EUR", "€", 0.8))
        self.assertEqual(currency.current({"usd_gbp": "bad"}), ("GBP", "£", 0.76))

    def test_format(self):
        self.assertEqual(currency.format_money(1234.5, "€"), "€1,234.50")
        self.assertEqual(currency.format_money(-3, "$"), "-$3.00")
        self.assertEqual(currency.format_money(250.4, "£", whole_above=100), "£250")

    def test_statusbar_shows_chosen_currency(self):
        style = statusbar.Style("dark", color=False, ascii_only=True)
        payload = {"model": {"id": "claude-opus-5-5"}, "cost": {"total_cost_usd": 2.0},
                   "context_window": {"used_percentage": 10}}
        for cfg, want in (({}, "£1.52"), ({"currency": "USD"}, "$2.00"), ({"currency": "EUR"}, "€1.72")):
            cfg = {**statusbar.DEFAULT_CFG, **cfg}
            line = statusbar.render(statusbar.gather(payload, cfg, {}), style, cfg)
            self.assertIn(want, line)

    def test_statusbar_flags(self):
        t = TempEnv()
        try:
            env = t.env(TOKENOMICS_HOME=str(t.home))
            payload = json.dumps({"cost": {"total_cost_usd": 1.0}})
            run = lambda *a: subprocess.run([sys.executable, str(SCRIPTS / "statusbar.py"), "--no-color", *a],  # noqa: E731
                                            input=payload, capture_output=True, text=True, env=env, timeout=30)
            self.assertIn("$1.00", run("--currency", "usd").stdout)
            self.assertIn("£0.76", run().stdout)
            self.assertIn("now show in EUR", run("--set-currency", "€").stdout)
            self.assertIn("€0.86", run().stdout)
            self.assertEqual(json.loads((t.home / "statusbar.json").read_text())["currency"], "EUR")
            self.assertEqual(run("--set-currency", "yen").returncode, 1)
        finally:
            t.cleanup()


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
        self.assertAlmostEqual(r["cost_usd"], 2.0 + 1.0)                 # 1M in @2 + 0.1M out @10
        self._finalize([user("hi"), sonnet_msg("m1"), sonnet_msg("m2")])  # one more turn
        self.assertAlmostEqual(self.t.session("c1")["cost_usd"], 6.0)
        events = self.t.rows("SELECT usd FROM cost_events WHERE session_id='c1' ORDER BY id")
        self.assertEqual([round(e["usd"], 2) for e in events], [3.0, 3.0])
        self._finalize([user("hi"), sonnet_msg("m1"), sonnet_msg("m2")])  # nothing new: no event
        self.assertEqual(len(self.t.rows("SELECT * FROM cost_events")), 2)

    def test_model_switch_priced_per_model(self):
        opus = assistant("m2", usage=SONNET)
        opus["message"]["model"] = "claude-opus-4-6"
        self._finalize([user("hi"), sonnet_msg("m1"), opus])
        self.assertAlmostEqual(self.t.session("c1")["cost_usd"], 3.0 + 7.5)     # Sonnet 5.5 + Opus 4.6

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
        os.environ.pop("TOKENOMICS_CURRENCY", None)

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
        d = self.check("a", "next", daily=10)
        self.assertEqual(d.action, "warned")
        self.assertIn("85%", d.message)
        self.assertIsNone(self.check("a", "again", daily=10))          # warned once only
        self.spend("a", 10.5)
        d = self.check("a", "do the thing", daily=10)
        self.assertEqual(d.action, "blocked")
        self.assertIn("£10.50", d.message)
        self.assertEqual(self.check("a", "something else", daily=10).action, "blocked")
        self.assertIsNone(self.check("a", "something else", daily=10))  # same prompt again = carry on
        self.assertIsNone(self.check("a", "more", daily=10))            # not paused again today

    def test_prefix_bypass_and_daily_sums_sessions(self):
        self.spend("a", 6)
        self.spend("b", 6)
        self.assertEqual(self.check("c", "hi", daily=10).action, "blocked")
        self.assertIsNone(self.check("c", "over-budget: hi", daily=10))

    def test_session_limit_is_per_session(self):
        self.spend("a", 6)
        self.assertEqual(self.check("a", "hi", session=5).action, "blocked")
        self.assertIsNone(self.check("b", "hi", session=5))

    def test_limits_and_messages_in_chosen_currency(self):
        self.spend("a", 10)                                                   # $10 spent
        with mock.patch.dict(os.environ, {"TOKENOMICS_CURRENCY": "EUR", "TOKENOMICS_USD_EUR": "0.9"}):
            d = self.check("a", "hi", daily=8)                                 # €9 > €8
        self.assertEqual(d.action, "blocked")
        self.assertIn("€9.00, over the €8.00 limit", d.message)
        self.db.commit()
        row = self.t.rows("SELECT spent, limit_amount, currency FROM budget_events WHERE action='blocked'")[0]
        self.assertEqual((round(row["spent"], 2), row["limit_amount"], row["currency"]), (9.0, 8.0, "EUR"))
        with mock.patch.dict(os.environ, {"TOKENOMICS_CURRENCY": "USD"}):
            self.assertEqual(self.check("b", "hi", daily=12).action, "warned")  # $10 of $12

    def test_limit_values_accept_symbols(self):
        with mock.patch.dict(os.environ, {"TOKENOMICS_BUDGET_DAILY": "€1,500", "TOKENOMICS_BUDGET_SESSION": "$5"}):
            lim = budget.load_limits()
        self.assertEqual((lim.daily, lim.session), (1500.0, 5.0))

    def test_old_budget_table_is_migrated(self):
        self.db.execute("""CREATE TABLE budget_events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
                           ts TEXT, day TEXT, kind TEXT, action TEXT, spent_gbp REAL, limit_gbp REAL, digest TEXT)""")
        self.spend("a", 20)
        self.assertEqual(self.check("a", "hi", daily=10).action, "blocked")

    def test_warn_mode_never_blocks(self):
        self.spend("a", 20)
        d = self.check("a", "hi", daily=10, mode="warn")
        self.assertEqual(d.action, "warned")
        self.assertNotIn("same prompt again", d.message)
        self.assertIsNone(self.check("a", "hi", daily=10, mode="warn"))

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
        self.assertIn("Spent today: £50.00 (GBP)", st.stdout)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def test_empty(self):
        r = report.build(str(self.t.home / "none.db"), 7, money=("GBP", "£", 1.0))
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
        r = report.build(self.t.db, 7, money=("GBP", "£", 1.0))
        self.assertFalse(r["empty"])
        self.assertEqual(r["spend"], 3.0)
        self.assertEqual(r["by_label"]["capex"]["sessions"], 1)
        self.assertEqual(r["by_project"][0]["project"], "api")
        self.assertEqual(r["top_sessions"][0]["model"], "claude-sonnet-5-5")
        self.assertEqual(r["helpers"]["diet"][0]["rule"], "unbounded-git-log")
        md = report.markdown(r)
        self.assertIn("**Spend: £3.00** GBP", md)
        eur = report.markdown(report.build(self.t.db, 7, money=("EUR", "€", 0.5)))
        self.assertIn("**Spend: €1.50** EUR", eur)
        self.assertNotIn("£", eur)
        self.assertIn("unbounded-git-log x1", md)
        p = subprocess.run([sys.executable, str(SCRIPTS / "report.py"), "--json", "--days", "0", "--currency", "$"],
                           capture_output=True, text=True, env=self.t.env(), timeout=30)
        out = json.loads(p.stdout)
        self.assertEqual((out["days"], out["currency"], out["spend"]), (0, "USD", 3.0))


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
