"""Platform capabilities, billing separation, session ids and graceful degradation."""
import json
import unittest
from unittest import mock

from helpers import TempEnv, assistant, user, write_transcript  # noqa: F401

from tokenomics.config import Settings
from tokenomics.engine import llm, session
from tokenomics.platform import registry
from tokenomics.platform.capabilities import (BILLING_ANTHROPIC_TOKENS, BILLING_COPILOT_PREMIUM_REQUESTS,
                                              Capability)
from tokenomics.platform.registry import get_adapter


class CapabilityTests(unittest.TestCase):
    def test_every_capability_declared(self):
        for name in ("claude-code", "copilot"):
            a = get_adapter(name)
            for cap in Capability:
                self.assertIn(cap, a.capabilities, f"{name} does not declare {cap}")

    def test_platform_facts(self):
        cc, cp = get_adapter("claude-code"), get_adapter("copilot")
        self.assertTrue(cc.supports(Capability.TRANSCRIPT) and cc.supports(Capability.TOKEN_USAGE))
        self.assertFalse(cp.supports(Capability.TRANSCRIPT))
        self.assertFalse(cp.supports(Capability.TOKEN_USAGE))
        self.assertFalse(cp.supports(Capability.BILLING_INFO))
        self.assertTrue(cp.supports(Capability.TOOL_EVENTS))
        self.assertEqual(cc.billing_model, BILLING_ANTHROPIC_TOKENS)
        self.assertEqual(cp.billing_model, BILLING_COPILOT_PREMIUM_REQUESTS)

    def test_report_is_json(self):
        json.dumps(registry.report())


class BillingTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.s = Settings(db_path=self.t.db)

    def tearDown(self):
        self.t.cleanup()

    def test_claude_tokens_reported(self):
        path = write_transcript(self.t.home, "c", [user("fix the bug in the parser code"), assistant("m", [("Edit", {})])])
        session.finalize(get_adapter("claude-code"), {"session_id": "c", "transcript_path": path}, self.s)
        r = self.t.session("c")
        self.assertEqual((r["input_tokens"], r["total_tokens"]), (100, 1160))
        self.assertEqual((r["billing_model"], r["usage_status"], r["evidence"]),
                         (BILLING_ANTHROPIC_TOKENS, "reported", "transcript"))

    def test_copilot_tokens_never_invented(self):
        a = get_adapter("copilot")
        session.record_prompt(a, {"sessionId": "g", "prompt": "write a function"}, self.s)
        session.finalize(a, {"sessionId": "g", "reason": "complete"}, self.s)
        r = self.t.session("g")
        for col in ("input_tokens", "output_tokens", "cache_read_tokens", "total_tokens"):
            self.assertIsNone(r[col], col)
        self.assertEqual((r["billing_model"], r["usage_status"], r["evidence"]),
                         (BILLING_COPILOT_PREMIUM_REQUESTS, "unavailable", "hook-events"))

    def test_copilot_transcript_is_not_read_even_if_given(self):
        path = write_transcript(self.t.home, "x", [user("hello"), assistant("m")])
        session.finalize(get_adapter("copilot"), {"sessionId": "x", "transcriptPath": path}, self.s)
        self.assertIsNone(self.t.session("x")["input_tokens"])


class SessionIdTests(unittest.TestCase):
    def test_all_spellings(self):
        cp = get_adapter("copilot")
        self.assertEqual(cp.session_id({"sessionId": "a"}), "a")
        self.assertEqual(cp.session_id({"session_id": "b"}), "b")
        self.assertTrue(cp.session_id({"cwd": "/w"}).startswith("anon-"))
        self.assertEqual(get_adapter("claude-code").session_id({"session_id": "c"}), "c")

    def test_copilot_tool_payload_spellings(self):
        cp = get_adapter("copilot")
        a = cp.tool_call({"toolName": "bash", "toolArgs": '{"command": "kubectl logs x"}'})
        b = cp.tool_call({"tool_name": "bash", "tool_input": {"command": "kubectl logs x"}})
        self.assertEqual((a.kind, a.command), ("shell", "kubectl logs x"))
        self.assertEqual(a, b)
        self.assertEqual(cp.tool_call({"toolName": "str_replace_editor", "toolArgs": {"command": "view"}}).kind, "read")
        self.assertIsNone(cp.tool_call({}))


class DegradationTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.s = Settings(db_path=self.t.db)

    def tearDown(self):
        self.t.cleanup()

    def test_broken_adapter_isolated(self):
        registry._cache.pop("copilot", None)
        with mock.patch.dict(registry.ADAPTERS, {"copilot": "tokenomics.adapters.missing:Nope"}):
            broken = get_adapter("copilot")
            registry._cache.pop("claude-code", None)
            ok = get_adapter("claude-code")
        registry._cache.pop("copilot", None)
        registry.load_errors.pop("copilot", None)
        self.assertEqual(type(broken).__name__, "GenericAdapter")
        self.assertEqual(type(ok).__name__, "ClaudeCodeAdapter")
        session.record_prompt(broken, {"sessionId": "b", "prompt": "check grafana"}, self.s)
        session.record_tool(broken, {"sessionId": "b", "toolName": "edit"}, self.s)   # no TOOL_EVENTS: ignored
        session.finalize(broken, {"sessionId": "b"}, self.s)
        self.assertEqual(self.t.session("b")["label"], "opex")
        self.assertEqual(self.t.rows("SELECT * FROM tool_events"), [])

    def test_unknown_source(self):
        a = get_adapter("some-new-ide")
        session.record_prompt(a, {"session_id": "u", "prompt": "refactor this module"}, self.s)
        self.assertEqual(self.t.session("u")["source"], "some-new-ide")

    def test_claude_missing_transcript_keeps_running_label(self):
        a = get_adapter("claude-code")
        session.record_prompt(a, {"session_id": "m", "prompt": "write a function"}, self.s)
        session.finalize(a, {"session_id": "m", "transcript_path": "/does/not/exist"}, self.s)
        r = self.t.session("m")
        self.assertEqual((r["label"], r["capex_score"], r["prompt_count"]), ("capex", 4, 1))


class LlmStepTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def test_llm_label_kept_and_shared(self):
        s = Settings(db_path=self.t.db, llm_enabled=True, llm_url="http://localhost:9/v1", store_prompt=True)
        res = {"label": "opex", "confidence": 0.9, "reason": "r", "model": "m"}
        with mock.patch.object(llm, "call", return_value=res) as call:
            path = write_transcript(self.t.home, "c", [user("write a function"), assistant("m")])
            session.finalize(get_adapter("claude-code"), {"session_id": "c", "transcript_path": path}, s)
            a = get_adapter("copilot")
            session.record_prompt(a, {"sessionId": "g", "prompt": "write a function"}, s)
            session.finalize(a, {"sessionId": "g"}, s)
            session.finalize(a, {"sessionId": "g"}, s)          # same input: no second call
        self.assertEqual(call.call_count, 2)
        for sid in ("c", "g"):
            r = self.t.session(sid)
            self.assertEqual((r["label"], r["label_source"]), ("opex", "llm"))

    def test_copilot_without_stored_prompts_stays_keywords(self):
        s = Settings(db_path=self.t.db, llm_enabled=True, llm_url="http://localhost:9/v1")
        with mock.patch.object(llm, "call") as call:
            a = get_adapter("copilot")
            session.record_prompt(a, {"sessionId": "g", "prompt": "write a function"}, s)
            session.finalize(a, {"sessionId": "g"}, s)
        call.assert_not_called()
        self.assertEqual(self.t.session("g")["label_source"], "keywords")

    def test_llm_failure_falls_back(self):
        s = Settings(db_path=self.t.db, llm_enabled=True, llm_url="http://127.0.0.1:9/v1", llm_timeout=1)
        path = write_transcript(self.t.home, "c", [user("write a function"), assistant("m")])
        session.finalize(get_adapter("claude-code"), {"session_id": "c", "transcript_path": path}, s)
        self.assertEqual(self.t.session("c")["label"], "capex")


if __name__ == "__main__":
    unittest.main()
