"""End-to-end through the real hook command, as each platform runs it."""
import json
import unittest

from helpers import ROOT, TempEnv, assistant, user, write_transcript


class HookRunTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()

    def tearDown(self):
        self.t.cleanup()

    def run_ok(self, mode, source, payload, **env):
        p = self.t.hook(mode, source, payload, **env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "", "hooks must print nothing")
        self.assertEqual(p.stderr, "")
        return p

    def test_claude_code_flow(self):
        path = write_transcript(self.t.home, "s", [
            user("why is the p99 latency up in grafana? check the loki logs"),
            assistant("m1", [("mcp__grafana__query", {}), ("Bash", {"command": "kubectl logs api-1"})]),
            user("<command-name>/grafana-triage</command-name>"),
            {"type": "system", "content": "Skills:\n- grafana-triage: Investigate dashboards and alerts for incidents"},
        ])
        self.run_ok("prompt", "claude-code", {"session_id": "s", "cwd": "/x", "prompt": "check the grafana dashboard"})
        self.run_ok("finalize", "claude-code", {"session_id": "s", "cwd": "/x", "hook_event_name": "SessionEnd",
                                                "transcript_path": path})
        r = self.t.session("s")
        # Regression values: identical to the pre-engine spendlens.py on this transcript.
        self.assertEqual((r["label"], r["opex_score"], r["capex_score"], r["prompt_count"]), ("opex", 27, 0, 2))
        self.assertEqual((r["total_tokens"], r["skill_opex"]), (1160, 1))
        self.assertEqual(json.loads(r["skills"]), ["grafana-triage"])

    def test_copilot_flow(self):
        sid = "3f1c-copilot"
        self.run_ok("prompt", "copilot", {"sessionId": sid, "timestamp": 1, "cwd": "/x",
                                          "prompt": "add a cli command to export the report"})
        self.run_ok("tool", "copilot", {"sessionId": sid, "timestamp": 2, "cwd": "/x", "toolName": "edit",
                                        "toolArgs": json.dumps({"path": "cli.py"}),
                                        "toolResult": {"resultType": "success"}})
        self.run_ok("finalize", "copilot", {"sessionId": sid, "timestamp": 3, "cwd": "/x", "reason": "complete"})
        r = self.t.session(sid)
        self.assertEqual((r["source"], r["label"], r["capex_score"], r["prompt_count"]), ("copilot", "capex", 7, 1))
        self.assertIsNone(r["total_tokens"])
        tools = self.t.rows("SELECT tool, kind FROM tool_events WHERE session_id=?", (sid,))
        self.assertEqual(tools, [{"tool": "edit", "kind": "code_edit"}])

    def test_finalize_is_idempotent(self):
        sid = "idem"
        self.run_ok("prompt", "copilot", {"sessionId": sid, "prompt": "check the grafana dashboard"})
        self.run_ok("tool", "copilot", {"sessionId": sid, "toolName": "bash", "toolArgs": {"command": "kubectl logs x"}})
        self.run_ok("finalize", "copilot", {"sessionId": sid})
        first = self.t.session(sid)["opex_score"]
        self.run_ok("finalize", "copilot", {"sessionId": sid})
        self.assertEqual(self.t.session(sid)["opex_score"], first)

    def test_bad_input_never_blocks(self):
        for payload in ("", "not json", "[1,2]", "{}"):
            for mode in ("prompt", "tool", "finalize"):
                for src in ("claude-code", "copilot", "unknown"):
                    self.run_ok(mode, src, payload)

    def test_capabilities_command(self):
        p = self.t.hook("capabilities", "", "")
        data = json.loads(p.stdout)
        self.assertEqual(set(data), {"claude-code", "copilot"})
        self.assertEqual(data["copilot"]["capabilities"]["token_usage"]["level"], "none")


class HookConfigTests(unittest.TestCase):
    def test_hook_files_use_known_modes(self):
        modes = {"prompt", "tool", "finalize"}
        cc = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        cp = json.loads((ROOT / "copilot-hooks.json").read_text())
        cmds = [h["command"] for arms in cc["hooks"].values() for g in arms for h in g["hooks"]]
        cmds += [h["bash"] for arms in cp["hooks"].values() for h in arms]
        lens = [c for c in cmds if "spendlens.py" in c]
        self.assertTrue(lens)
        for c in lens:
            parts = c.replace('"', "").split()
            i = [n for n, x in enumerate(parts) if x.endswith("spendlens.py")][0]
            self.assertIn(parts[i + 1], modes, c)
        self.assertTrue(any(" tool copilot" in c for c in lens), "copilot postToolUse not wired")


if __name__ == "__main__":
    unittest.main()
