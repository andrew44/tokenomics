"""The standalone scripts: coach, dashboard, handoff, statusbar, pennywise."""
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
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


class StatusbarInstallTests(unittest.TestCase):
    """--sync is the plugin's SessionStart hook: it offers, auto-installs and refreshes the bar."""

    def setUp(self):
        self.t = TempEnv()
        h = self.t.home
        self.env = self.t.env(TOKENOMICS_HOME=str(h / ".tokenomics"), CLAUDE_CONFIG_DIR=str(h / ".claude"),
                              COPILOT_HOME=str(h / ".copilot"))
        self.settings = h / ".claude" / "settings.json"
        self.copy = h / ".tokenomics" / "statusbar.py"

    def tearDown(self):
        self.t.cleanup()

    def run_bar(self, *args, **env):
        p = subprocess.run([sys.executable, str(SCRIPTS / "statusbar.py"), *args], input="{}",
                           capture_output=True, text=True, env={**self.env, **env}, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def test_installs_by_default(self):
        self.assertIn("installed", json.loads(self.run_bar("--sync"))["systemMessage"])
        self.assertIn(str(self.copy), json.loads(self.settings.read_text())["statusLine"]["command"])

    def test_ask_offers_once_then_stays_quiet(self):
        msg = json.loads(self.run_bar("--sync", TOKENOMICS_STATUSBAR="ask"))["systemMessage"]
        self.assertIn("/tokenomics:statusbar", msg)
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSBAR="ask"), "")
        self.assertFalse(self.settings.exists())

    def test_install_keep_existing_skips_another_status_line(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps({"statusLine": {"type": "command", "command": "mine"}}))
        self.assertIn("Skipped claude", self.run_bar("--install", "claude", "--keep-existing"))
        self.assertEqual(json.loads(self.settings.read_text())["statusLine"]["command"], "mine")
        self.run_bar("--install", "claude")                   # without the flag it replaces it
        self.assertIn(str(self.copy), json.loads(self.settings.read_text())["statusLine"]["command"])

    def test_off_never_offers(self):
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSBAR="off"), "")

    def test_auto_installs_and_refreshes(self):
        self.assertIn("installed", self.run_bar("--sync", TOKENOMICS_STATUSBAR="auto"))
        self.assertIn(str(self.copy), json.loads(self.settings.read_text())["statusLine"]["command"])
        self.copy.write_text("# stale\n")
        self.assertEqual(self.run_bar("--sync"), "")
        self.assertEqual(self.copy.read_bytes(), (SCRIPTS / "statusbar.py").read_bytes())
        self.assertTrue((self.copy.parent / "model-prices.json").is_file())
        self.assertIn("claude: installed", self.run_bar("--status"))

    def test_leaves_another_status_line_alone(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps({"statusLine": {"type": "command", "command": "mine"}}))
        self.assertEqual(self.run_bar("--sync", TOKENOMICS_STATUSBAR="auto"), "")
        self.assertEqual(json.loads(self.settings.read_text())["statusLine"]["command"], "mine")
        self.assertIn("another status line", self.run_bar("--status"))


class PennywiseTests(unittest.TestCase):
    def test_rate(self):
        self.assertEqual(pennywise.rate("create a hello world console app")[0], 1)
        self.assertIsNone(pennywise.rate("design the architecture for a distributed queue")[0])
        self.assertIsNone(pennywise.rate("```\ncode\n```")[0])

    def test_tier_of(self):
        self.assertEqual([pennywise.tier_of(m) for m in ("claude-haiku-x", "Sonnet", "opus", "gpt-5")],
                         [1, 2, 3, None])

    def _handle(self, prompt, model="claude-opus-5-5", mode="route"):
        old = pennywise.MODE
        pennywise.MODE = mode
        try:
            with tempfile.TemporaryDirectory() as d, \
                    mock.patch.object(pennywise, "DB_PATH", str(Path(d) / "db.sqlite")), \
                    mock.patch.object(pennywise, "STATE_PATH", Path(d) / "state.json"):
                return pennywise.handle({"session_id": "s", "model": model, "prompt": prompt})
        finally:
            pennywise.MODE = old

    def test_routes_simple_prompt_to_cheaper_subagent(self):
        out = self._handle("create a hello world console app")
        self.assertNotIn("decision", out)
        ctx = out["hookSpecificOutput"]
        self.assertEqual(ctx["hookEventName"], "UserPromptSubmit")
        self.assertIn('model: "haiku"', ctx["additionalContext"])
        self.assertIn("Haiku", out["systemMessage"])

    def test_route_leaves_hard_cheap_and_bypassed_prompts_alone(self):
        self.assertIsNone(self._handle("design the architecture for a distributed queue"))
        self.assertIsNone(self._handle("create a hello world console app", model="claude-haiku-5-5"))
        self.assertIsNone(self._handle("keep-model: create a hello world console app"))

    def test_block_mode_still_pauses(self):
        self.assertEqual(self._handle("create a hello world console app", mode="block")["decision"], "block")


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
    def test_setup_installs_plugin_statusbar_and_launcher(self):
        out = self.cli("setup")
        self.assertIn("plugin installed", out)
        self.assertIn("plugin install tokenomics@tokenomics", self.log.read_text())
        self.assertIn("statusbar.py", json.loads(self.settings.read_text())["statusLine"]["command"])
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
