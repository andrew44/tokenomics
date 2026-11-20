"""The standalone scripts: coach, dashboard, doggybag, statusline, pennywise."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

from helpers import ROOT, USAGE, TempEnv, assistant, user, write_transcript

SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import dashboard  # noqa: E402
import doggybag  # noqa: E402
import pennywise  # noqa: E402
import statusline  # noqa: E402


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


class DoggybagTests(unittest.TestCase):
    def setUp(self):
        self.t = TempEnv()
        self.cwd = self.t.home / "proj"
        self.cwd.mkdir()

    def tearDown(self):
        self.t.cleanup()

    def _meta(self, **kw):
        d = doggybag.bag_dir(str(self.cwd), create=True)
        md = d / "old.md"
        md.write_text("# Doggybag")
        meta = {"session_id": "old", "cwd": str(self.cwd), "written": time.time(), "path": str(md)}
        meta.update(kw)
        (d / "old.json").write_text(json.dumps(meta))

    def _transcript(self, ts):
        usage = dict(USAGE, cache_read_input_tokens=50000)
        rec = assistant("m1", [("Edit", {"file_path": "/w/login.py"})], usage=usage)
        rec["timestamp"] = ts
        return write_transcript(self.t.home, "sess", [user("add a login page"), rec])

    def test_folder_is_inside_project_and_self_ignoring(self):
        d = doggybag.bag_dir(str(self.cwd), create=True)
        self.assertEqual(d, self.cwd / ".doggybag")
        self.assertIn("*", (d / ".gitignore").read_text())

    def test_pack_writes_session_file_and_latest(self):
        path = self._transcript("2026-01-01T00:00:00Z")
        m = doggybag.pack({"session_id": "sess", "cwd": str(self.cwd), "transcript_path": path}, "claude-code", "manual")
        d = self.cwd / ".doggybag"
        self.assertEqual(Path(m["path"]), d / "sess.md")
        self.assertTrue((d / "latest.md").read_text().startswith("# Doggybag: session sess"))
        self.assertIn(".doggybag/latest.md", (d / "sess.md").read_text())

    def test_start_injects_latest_by_default(self):
        self._meta(handoff_tokens=900, ctx_tokens=150000)
        out = doggybag.start({"session_id": "new", "cwd": str(self.cwd), "source": "clear"})
        self.assertIn("about 900 tokens vs 150,000", out["systemMessage"])
        self.assertIn("# Doggybag", out["hookSpecificOutput"]["additionalContext"])

    def test_start_notice_only(self):
        self._meta()
        with mock.patch.object(doggybag, "INJECT", False):
            out = doggybag.start({"session_id": "new", "cwd": str(self.cwd), "source": "startup"})
        self.assertIn("about ? tokens vs ?", out["systemMessage"])
        self.assertNotIn("hookSpecificOutput", out)

    def test_cold_prompt_packs_and_warns(self):
        path = self._transcript("2020-01-01T00:00:00Z")          # cache long expired
        d = {"session_id": "sess", "cwd": str(self.cwd), "transcript_path": path, "prompt": "carry on"}
        with mock.patch.object(doggybag, "COLD_MIN_TOKENS", 0):
            out = doggybag.prompt(d, "claude-code")
        self.assertIn("went cold", out["systemMessage"])
        self.assertTrue((self.cwd / ".doggybag" / "latest.md").is_file())

    def test_cold_prompt_block_once(self):
        path = self._transcript("2020-01-01T00:00:00Z")
        d = {"session_id": "sess", "cwd": str(self.cwd), "transcript_path": path, "prompt": "carry on"}
        with mock.patch.object(doggybag, "COLD_MIN_TOKENS", 0), mock.patch.object(doggybag, "COLD_MODE", "block"):
            self.assertEqual(doggybag.prompt(d, "claude-code")["decision"], "block")
            self.assertNotIn("decision", doggybag.prompt(d, "claude-code"))

    def test_warm_prompt_is_silent(self):
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        path = self._transcript(ts)
        d = {"session_id": "sess", "cwd": str(self.cwd), "transcript_path": path, "prompt": "carry on"}
        self.assertIsNone(doggybag.prompt(d, "claude-code"))

    def test_copilot_prefers_own_session_transcript(self):
        root = self.t.home / "session-state"
        for sid in ("mine", "other"):
            (root / sid).mkdir(parents=True)
            (root / sid / "events.jsonl").write_text("{}\n")
            time.sleep(0.02)                              # "other" is newer
        p = doggybag.resolve_transcript({"sessionId": "mine", "transcript_path": str(root)}, "copilot")
        self.assertEqual(p.parent.name, "mine")
        p = doggybag.resolve_transcript({"transcript_path": str(root)}, "copilot")
        self.assertEqual(p.parent.name, "other")

    def test_digest(self):
        path = write_transcript(self.t.home, "h", [
            user("add a login page"),
            assistant("m1", [("Edit", {"file_path": "/w/login.py"}), ("Bash", {"command": "pytest -q"})]),
        ])
        r = doggybag.digest(path)
        self.assertEqual((r["prompts"], r["files"], r["cmds"]), (["add a login page"], ["/w/login.py"], ["pytest -q"]))


class StatuslineTests(unittest.TestCase):
    def test_most_specific_price_wins(self):
        cfg = {"prices": {"opus": [9, 90], "claude-opus-4-6": [6, 30]}}
        r = statusline.rates_for("claude-opus-4-6", cfg)
        self.assertEqual((r["input"], r["output"]), (6.0, 30.0))
        self.assertAlmostEqual(r["cache_read"], 0.6)
        self.assertEqual(statusline.rates_for("claude-opus-4-7", cfg)["input"], 9.0)   # only the family override matches
        self.assertEqual(statusline.price_for("mystery", {}), statusline.DEFAULT_PRICE)

    def test_gather_accepts_string_model(self):
        info = statusline.gather({"model": "gpt-5", "context_window": {"used_percentage": 40}},
                                dict(statusline.DEFAULT_CFG), {})
        self.assertEqual((info["model"], info["pct"]), ("gpt-5", 40.0))

    def test_live_transcript_survives_cache_trim(self):
        t = TempEnv()
        try:
            state = {"transcripts": {f"/old/{i}.jsonl": {"offset": 10 ** 9, "seen": i} for i in range(20)}}
            path = write_transcript(t.home, "live", [assistant("m1")])
            statusline.scan_transcript(path, state, dict(statusline.DEFAULT_CFG))
            self.assertIn(path, state["transcripts"])
            self.assertEqual(len(state["transcripts"]), 20)
        finally:
            t.cleanup()

    def test_render_plain(self):
        cfg = dict(statusline.DEFAULT_CFG)
        info = {"model": "Sonnet", "total": 12_300, "cost": 1.5, "symbol": "£", "estimated": True,
                "pct": 50, "ttl": 300, "remaining": 90}
        line = statusline.render(info, statusline.Style("dark", color=False, ascii_only=True), cfg)
        self.assertEqual(line, "* Sonnet | ctx ######------ 50% | tok 12.3K | ~£1.50 | [# ] 01:30")


class StatuslineInstallTests(unittest.TestCase):
    """--sync is the plugin's SessionStart hook: it offers, auto-installs and refreshes the CLI
    statusline, and moves a pre-v1.4 "statusbar" install to the new names."""

    def setUp(self):
        self.t = TempEnv()
        h = self.t.home
        self.env = self.t.env(TOKENOMICS_HOME=str(h / ".tokenomics"), CLAUDE_CONFIG_DIR=str(h / ".claude"),
                              COPILOT_HOME=str(h / ".copilot"))
        self.settings = h / ".claude" / "settings.json"
        self.copy = h / ".tokenomics" / "statusline.py"

    def tearDown(self):
        self.t.cleanup()

    def run_bar(self, *args, **env):
        p = subprocess.run([sys.executable, str(SCRIPTS / "statusline.py"), *args], input="{}",
                           capture_output=True, text=True, env={**self.env, **env}, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def test_installs_by_default(self):
        self.assertIn("installed", json.loads(self.run_bar("--sync"))["systemMessage"])
        self.assertIn(str(self.copy), json.loads(self.settings.read_text())["statusLine"]["command"])

    def test_ask_offers_once_then_stays_quiet(self):
        msg = json.loads(self.run_bar("--sync", TOKENOMICS_STATUSLINE="ask"))["systemMessage"]
        self.assertIn("/tokenomics:statusline", msg)
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSLINE="ask"), "")
        self.assertFalse(self.settings.exists())

    def test_install_keep_existing_skips_another_status_line(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps({"statusLine": {"type": "command", "command": "mine"}}))
        self.assertIn("Skipped claude", self.run_bar("--install", "claude", "--keep-existing"))
        self.assertEqual(json.loads(self.settings.read_text())["statusLine"]["command"], "mine")
        self.run_bar("--install", "claude")                   # without the flag it replaces it
        self.assertIn(str(self.copy), json.loads(self.settings.read_text())["statusLine"]["command"])

    def test_off_never_offers(self):
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSLINE="off"), "")
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSBAR="off"), "")    # the old name still works

    def test_auto_installs_and_refreshes(self):
        self.assertIn("installed", self.run_bar("--sync", TOKENOMICS_STATUSLINE="auto"))
        self.assertIn(str(self.copy), json.loads(self.settings.read_text())["statusLine"]["command"])
        self.copy.write_text("# stale\n")
        self.assertEqual(self.run_bar("--sync"), "")
        self.assertEqual(self.copy.read_bytes(), (SCRIPTS / "statusline.py").read_bytes())
        self.assertTrue((self.copy.parent / "model-prices.json").is_file())
        self.assertIn("claude statusline: installed", self.run_bar("--status"))
        self.assertIn("claude band (desktop app): on", self.run_bar("--status"))

    def test_leaves_another_status_line_alone(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps({"statusLine": {"type": "command", "command": "mine"}}))
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSLINE="auto"), "")
        self.assertEqual(json.loads(self.settings.read_text())["statusLine"]["command"], "mine")
        self.assertIn("another status line", self.run_bar("--status"))

    def test_sync_message_names_the_band_in_the_desktop_app(self):
        msg = json.loads(self.run_bar("--sync", CLAUDE_CODE_ENTRYPOINT="claude-desktop"))["systemMessage"]
        self.assertIn("statusline installed", msg)
        self.assertIn("in the band above the prompt box", msg)
        self.assertIn("restart Claude Code", json.loads(self.run_bar("--uninstall", "claude") and
                                                        self.run_bar("--sync"))["systemMessage"])

    def test_migrates_a_statusbar_install(self):
        """Before v1.4: ~/.tokenomics/statusbar.py in settings.json, config in statusbar.json."""
        home = self.copy.parent
        home.mkdir(parents=True)
        old = home / "statusbar.py"
        old.write_text("# the old copy\n")
        (home / "statusbar.json").write_text(json.dumps({"currency": "EUR"}))
        (home / "statusbar-offered").write_text("x")
        (home / "statusbar-state.json").write_text("{}")
        for path, flags in ((self.settings, {}), (self.t.home / ".copilot" / "settings.json",
                                                  {"feature_flags": {"enabled": ["STATUS_LINE"]}})):
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"statusLine": {"type": "command", "command": f'"python3" "{old}"'},
                                        **flags}))
        # still read as ours, and its config, before anything has moved
        self.assertIn("claude statusline: installed", self.run_bar("--status"))
        self.assertIn("€", self.run_bar("--no-color"))

        self.assertEqual(self.run_bar("--sync"), "")
        for path in (self.settings, self.t.home / ".copilot" / "settings.json"):
            self.assertIn(str(self.copy), json.loads(path.read_text())["statusLine"]["command"], path)
        self.assertEqual(json.loads((home / "statusline.json").read_text())["currency"], "EUR")
        self.assertTrue((home / "statusline-offered").exists())
        for gone in ("statusbar.py", "statusbar.json", "statusbar-offered", "statusbar-state.json"):
            self.assertFalse((home / gone).exists(), gone)
        self.assertTrue(self.copy.is_file())
        self.assertIn("€", self.run_bar("--no-color"))


class PennywiseTests(unittest.TestCase):
    def test_score_tiers(self):
        tiers = [pennywise.score(p)["tier"] for p in (
            "create a hello world console app",
            "add a /health endpoint to the flask api",
            "refactor the auth module across all services and migrate the database schema",
            "design the architecture for a distributed queue and compare the trade-offs")]
        self.assertEqual(tiers, ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"])

    def test_tier_map_from_env(self):
        with mock.patch.dict(os.environ, {"TOKENOMICS_ROUTER_TIERS": "REASONING=fable"}):
            r = pennywise.score("design the architecture and compare the trade-offs", cfg=pennywise.load_config())
        self.assertEqual(r["model"], "fable")
        self.assertTrue(pennywise.resolve_model("fable").startswith("claude-fable"))

    def test_tier_of(self):
        self.assertEqual([pennywise.tier_of(m) for m in ("claude-haiku-x", "Sonnet", "opus", "claude-fable-5-2", "gpt-5")],
                         [1, 2, 3, 4, None])

    def _handle(self, prompt, model="claude-opus-5-5", mode="route"):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(pennywise, "MODE", mode), \
                mock.patch.dict(os.environ, {"ANTHROPIC_BASE_URL": ""}), \
                mock.patch.object(pennywise, "DB_PATH", str(Path(d) / "db.sqlite")), \
                mock.patch.object(pennywise, "STATE_PATH", Path(d) / "state.json"):
            return pennywise.handle({"session_id": "s", "model": model, "prompt": prompt})

    def test_routes_simple_prompt_down(self):
        out = self._handle("create a hello world console app")
        self.assertNotIn("decision", out)
        ctx = out["hookSpecificOutput"]
        self.assertEqual(ctx["hookEventName"], "UserPromptSubmit")
        self.assertIn('model: "haiku"', ctx["additionalContext"])
        self.assertIn("down to Haiku", out["systemMessage"])

    def test_routes_hard_prompt_up(self):
        out = self._handle("design the architecture for a distributed queue and compare trade-offs",
                           model="claude-haiku-5-5")
        self.assertIn('model: "opus"', out["hookSpecificOutput"]["additionalContext"])

    def test_forced_model(self):
        out = self._handle("sonnet: summarise the README")
        self.assertIn('model: "sonnet"', out["hookSpecificOutput"]["additionalContext"])

    def test_leaves_follow_ups_bypass_and_same_tier_alone(self):
        self.assertIsNone(self._handle("yes, do it"))
        self.assertIsNone(self._handle("create a hello world console app", model="claude-haiku-5-5"))
        self.assertIsNone(self._handle("keep-model: create a hello world console app"))
        self.assertIsNone(self._handle("create a hello world console app", mode="proxy"))

    def test_block_mode_still_pauses(self):
        self.assertEqual(self._handle("create a hello world console app", mode="block")["decision"], "block")


class PennywiseProxyTests(unittest.TestCase):
    """The routing proxy against a fake upstream."""

    def setUp(self):
        import http.server
        import threading
        self.seen = []
        seen = self.seen

        class Up(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append(b["model"])
                if b["model"].startswith("claude-haiku") and "FAIL" in json.dumps(b):
                    self.send_response(529)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for i in range(3):
                    self.wfile.write(f"data: {i}\n\n".encode())

        self.tmp = tempfile.TemporaryDirectory()
        self.db = mock.patch.object(pennywise, "DB_PATH", str(Path(self.tmp.name) / "db.sqlite"))
        self.db.start()
        self.up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Up)
        threading.Thread(target=self.up.serve_forever, daemon=True).start()
        self.srv = pennywise.serve(0, upstream=f"http://127.0.0.1:{self.up.server_port}")
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.up.shutdown()
        self.db.stop()
        self.tmp.cleanup()

    def call(self, msgs, model="pennywise"):
        import urllib.request
        r = urllib.request.Request(f"http://127.0.0.1:{self.srv.server_port}/v1/messages", method="POST",
                                   data=json.dumps({"model": model, "system": "s", "messages": msgs}).encode(),
                                   headers={"content-type": "application/json"})
        return urllib.request.urlopen(r, timeout=10).read().decode()

    def test_routing(self):
        first = {"role": "user", "content": "create a hello world console app"}
        self.assertEqual(self.call([first]).count("data:"), 3)            # stream passes through
        loop = [first, {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]}]
        self.call(loop)
        hard = loop + [{"role": "assistant", "content": "done"},
                       {"role": "user", "content": "design the architecture for a queue and compare trade-offs"}]
        self.call(hard)
        big = hard + [{"role": "assistant", "content": "x" * 200000}, {"role": "user", "content": "fix the typo"}]
        self.call(big)                                                    # warm + big context: stays put
        self.call([{"role": "user", "content": "FAIL fix the typo"}])     # haiku fails -> fallback
        self.call([first], model="claude-haiku-5-5")                      # not ours: untouched
        fams = [m.split("-")[1] for m in self.seen]
        self.assertEqual(fams, ["haiku", "haiku", "opus", "opus", "haiku", "opus", "haiku"])


if __name__ == "__main__":
    unittest.main()


class CliTests(unittest.TestCase):
    """scripts/cli.py: the `tokenomics` command the one-line installer sets up."""

    def setUp(self):
        self.t = TempEnv()
        h = self.t.home
        self.fakebin = h / "fakebin"
        self.fakebin.mkdir()
        self.log = h / "claude.log"
        if sys.platform != "win32":
            claude = self.fakebin / "claude"
            claude.write_text(f'#!/bin/sh\necho "$*" >> "{self.log}"\n')
            claude.chmod(0o755)
        self.env = self.t.env(TOKENOMICS_HOME=str(h / ".tokenomics"), CLAUDE_CONFIG_DIR=str(h / ".claude"),
                              COPILOT_HOME=str(h / ".copilot"), SHELL="/bin/bash",
                              PATH=str(self.fakebin) + ":/usr/bin:/bin")
        self.settings = h / ".claude" / "settings.json"

    def tearDown(self):
        self.t.cleanup()

    def cli(self, *args):
        p = subprocess.run([sys.executable, str(SCRIPTS / "cli.py"), *args], capture_output=True, text=True,
                           env=self.env, timeout=60, stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    @unittest.skipIf(sys.platform == "win32", "uses a shell-script stand-in for claude")
    def test_setup_installs_plugin_statusline_and_launcher(self):
        out = self.cli("setup")
        self.assertIn("plugin installed", out)
        self.assertIn("plugin install tokenomics@tokenomics", self.log.read_text())
        self.assertIn("statusline.py", json.loads(self.settings.read_text())["statusLine"]["command"])
        launcher = self.t.home / ".local" / "bin" / "tokenomics"
        self.assertTrue(launcher.is_file())
        rc = self.t.home / (".bash_profile" if sys.platform == "darwin" else ".bashrc")   # what bash reads
        self.assertIn("added by the tokenomics installer", rc.read_text())
        self.cli("setup")                                       # idempotent: one PATH line only
        self.assertEqual(rc.read_text().count("tokenomics installer"), 1)

        self.cli("uninstall")
        self.assertNotIn("statusLine", json.loads(self.settings.read_text()))
        self.assertFalse(launcher.exists())
        self.assertNotIn("tokenomics", rc.read_text())
        self.assertIn("plugin uninstall tokenomics@tokenomics", self.log.read_text())

    @unittest.skipIf(sys.platform == "win32", "uses a shell-script stand-in for claude")
    def test_setup_keeps_someone_elses_status_line(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps({"statusLine": {"type": "command", "command": "mine"}}))
        self.assertIn("kept your existing status line", self.cli("setup", "--no-plugin"))
        self.assertEqual(json.loads(self.settings.read_text())["statusLine"]["command"], "mine")
        self.cli("uninstall")                                   # and uninstall leaves it alone too
        self.assertEqual(json.loads(self.settings.read_text())["statusLine"]["command"], "mine")

    def test_no_assistant_found_still_gives_a_command(self):
        self.env["PATH"] = str(self.t.home / "empty")
        self.assertIn("Neither Claude Code", self.cli("setup"))

    def test_dashboard_runs_in_background_and_stops(self):
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = str(s.getsockname()[1])
        out = self.cli("dashboard", "--demo", "--no-open", "--port", port)
        try:
            self.assertIn("running on", out)
            self.assertTrue(dashboard._port_busy(int(port)))
        finally:
            self.assertIn("Stopped", self.cli("dashboard", "--stop"))


class InstallerScriptTests(unittest.TestCase):
    def test_install_sh_is_valid_and_runs_cli_setup(self):
        text = (ROOT / "install.sh").read_text()
        self.assertIn("scripts/cli.py\" setup", text)
        self.assertTrue(text.rstrip().endswith('main "$@"'))     # nothing runs until fully downloaded
        if sys.platform != "win32":
            r = subprocess.run(["sh", "-n", str(ROOT / "install.sh")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_install_ps1_runs_cli_setup(self):
        self.assertIn("scripts\\cli.py') setup", (ROOT / "install.ps1").read_text())


@unittest.skipIf(sys.platform == "win32", "needs a POSIX sh; Windows CI would run it through Git Bash")
class RunLauncherTests(unittest.TestCase):
    """scripts/run.sh: how every hook and skill finds Python, on any OS."""

    def setUp(self):
        self.t = TempEnv()
        h = self.t.home
        self.bin = h / "bin"
        self.bin.mkdir()
        self.pybin = h / "pybin"                                  # Pythons live here, on PATH or not
        self.pybin.mkdir()
        self.cache = h / ".tokenomics" / "python"
        self.probe = h / "probe.py"
        self.probe.write_text("import sys\nprint(sys.stdin.read().upper(), sys.argv[1:])\nsys.exit(3)\n")
        (SCRIPTS / "_run_probe.py").write_text(self.probe.read_text())
        self.addCleanup((SCRIPTS / "_run_probe.py").unlink)
        for tool in ("dirname", "head", "tr", "mkdir"):          # what run.sh itself needs
            (self.bin / tool).symlink_to(shutil.which(tool))

    def tearDown(self):
        self.t.cleanup()

    def link(self, name):
        (self.pybin / name).symlink_to(sys.executable)

    def run_sh(self, python_on_path=True):
        # Only bin/ (and pybin/) on PATH, so the only Pythons are the ones a test links in.
        env = self.t.env(PATH=f"{self.bin}:{self.pybin}" if python_on_path else str(self.bin))
        return subprocess.run(["/bin/sh", str(SCRIPTS / "run.sh"), "_run_probe.py", "a", "b c"], input="hi",
                              capture_output=True, text=True, env=env, timeout=30)

    def test_passes_stdin_args_and_exit_code_and_caches(self):
        self.link("python")                                   # Windows-style: no python3
        r = self.run_sh()
        self.assertEqual(r.returncode, 3, r.stderr + r.stdout)
        self.assertIn("HI ['a', 'b c']", r.stdout)
        self.assertEqual(Path(self.cache.read_text().strip()).resolve(), Path(sys.executable).resolve())
        self.assertEqual(self.run_sh(python_on_path=False).returncode, 3)   # only the cache can work

    def test_stale_cache_falls_back_and_missing_python_never_blocks(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text("/nowhere/python.exe\n")
        r = self.run_sh()
        self.assertEqual(r.returncode, 0)                     # no Python at all: warn, don't block
        self.assertIn("Python 3.8+ not found", r.stderr)
        self.link("python3")
        self.assertEqual(self.run_sh().returncode, 3)


class HookLauncherWiringTests(unittest.TestCase):
    def test_every_hook_and_skill_goes_through_the_launcher(self):
        cc = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        cmds = [h["command"] for arms in cc["hooks"].values() for g in arms for h in g["hooks"]]
        cp = json.loads((ROOT / "copilot-hooks.json").read_text())
        cmds += [h["bash"] for arms in cp["hooks"].values() for h in arms]
        for c in cmds:
            self.assertRegex(c, r"^sh \S*run\.sh\"? \w+\.py", c)
            self.assertTrue((SCRIPTS / c.split("run.sh")[1].replace('"', "").split()[0]).is_file(), c)
        for h in (h for arms in cp["hooks"].values() for h in arms):
            self.assertIn(".tokenomics/python", h["powershell"])
        for skill in (ROOT / "skills").glob("*/SKILL.md"):
            self.assertNotIn('python3 "${CLAUDE_PLUGIN_ROOT}', skill.read_text(), skill)
