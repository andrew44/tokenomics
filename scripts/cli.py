#!/usr/bin/env python3
"""tokenomics: one command for setup, the dashboard, reports and updates.

Installed by the one-line installer (install.sh / install.ps1) as `tokenomics` on your PATH:

  tokenomics                    what's installed, and what to try next
  tokenomics dashboard [--demo] open the dashboard (runs in the background; --stop to stop it)
  tokenomics report [--days N]  spend report in the terminal
  tokenomics statusline [...]   statusline and band options, e.g. --demo, --set-currency USD,
                                --band-off, --status   ("statusbar", the old name, still works)
  tokenomics router [...]       pennywise model router: serve [--port N], explain "prompt", env
  tokenomics doggybag           pack a doggybag (resume note) for this folder's latest session now
  tokenomics update             fetch the latest version and refresh everything
  tokenomics uninstall [--purge]  remove it all (--purge also deletes your recorded data)
  tokenomics setup              (re)do the setup the installer does; idempotent

Setup does, for each assistant it finds on this computer:
  Claude Code  -> adds the plugin (skills + hooks + the desktop app's band) and the statusline
  Copilot CLI  -> adds the plugin and the statusline
It never replaces a status line you already have. Stdlib only, Python 3.8+.
"""
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
HOME = Path.home()
TK_HOME = Path(os.environ.get("TOKENOMICS_HOME", str(HOME / ".tokenomics")))
APP_DIR = TK_HOME / "app"
REPO = os.environ.get("TOKENOMICS_REPO", "andrew44/tokenomics")
REF = os.environ.get("TOKENOMICS_REF", "main")
MARKETPLACE = "tokenomics"
PLUGIN = "tokenomics@tokenomics"
WINDOWS = os.name == "nt"
RC_MARK = "# added by the tokenomics installer"


def say(msg=""):
    print(msg, flush=True)


def run(cmd, quiet=True):
    """Run a command; True on success. Never reads our stdin (the installer may be piped in)."""
    exe = shutil.which(cmd[0])        # on Windows `claude` is often claude.cmd, which needs its full path
    if not exe:
        return False
    try:
        p = subprocess.run([exe, *cmd[1:]], stdin=subprocess.DEVNULL, capture_output=quiet, text=True,
                           encoding="utf-8", errors="replace", timeout=300)
        return p.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def script(name, *args):
    return subprocess.call([sys.executable, str(HERE / name), *args], stdin=subprocess.DEVNULL)


# ---- assistants ---------------------------------------------------------------------------------

def has(cli):
    return shutil.which(cli) is not None


def claude_plugin(action):
    if action == "install":
        run(["claude", "plugin", "marketplace", "add", REPO])
        run(["claude", "plugin", "marketplace", "update", MARKETPLACE])
        return (run(["claude", "plugin", "install", PLUGIN])
                or run(["claude", "plugin", "update", PLUGIN]))
    if action == "update":
        run(["claude", "plugin", "marketplace", "update", MARKETPLACE])
        return run(["claude", "plugin", "update", PLUGIN])
    ok = run(["claude", "plugin", "uninstall", PLUGIN])
    run(["claude", "plugin", "marketplace", "remove", MARKETPLACE])
    return ok


def copilot_plugin(action):
    if action == "install":
        return run(["copilot", "plugin", "install", REPO]) or run(["copilot", "plugin", "update", "tokenomics"])
    if action == "update":
        return run(["copilot", "plugin", "update", "tokenomics"]) or run(["copilot", "plugin", "install", REPO])
    return run(["copilot", "plugin", "uninstall", "tokenomics"])


# ---- the `tokenomics` launcher ------------------------------------------------------------------

def _on_path(d):
    parts = [os.path.normcase(os.path.realpath(p)) for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    return os.path.normcase(os.path.realpath(str(d))) in parts


def _bin_dir():
    if WINDOWS:
        return TK_HOME / "bin"
    for d in (HOME / ".local" / "bin", HOME / "bin"):
        if _on_path(d):
            return d
    return HOME / ".local" / "bin"


def _rc_files():
    shell = os.path.basename(os.environ.get("SHELL", ""))
    if shell == "zsh":
        return [HOME / ".zshrc"]
    if shell == "bash":
        return [HOME / (".bash_profile" if sys.platform == "darwin" else ".bashrc")]
    if shell == "fish":
        return []
    return [HOME / ".profile"]


def remember_python():
    """Record this Python for scripts/run.sh and the Copilot hooks, so they never have to guess
    (on Windows `python3` is usually missing or the Microsoft Store stub)."""
    try:
        TK_HOME.mkdir(parents=True, exist_ok=True)
        (TK_HOME / "python").write_text(sys.executable.replace("\\", "/") + "\n", encoding="utf-8")
    except OSError:
        pass


def install_launcher():
    """Write the `tokenomics` command; returns (path, needs_new_terminal)."""
    d = _bin_dir()
    d.mkdir(parents=True, exist_ok=True)
    cli = Path(__file__).resolve()
    if WINDOWS:
        path = d / "tokenomics.cmd"
        path.write_text(f'@"{sys.executable}" "{cli}" %*\r\n', encoding="utf-8")
    else:
        path = d / "tokenomics"
        path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{cli}" "$@"\n', encoding="utf-8")
        path.chmod(0o755)
    if _on_path(d):
        return path, False
    if WINDOWS:                                           # install.ps1 puts this folder on PATH
        return path, True
    line = f'export PATH="{d}:$PATH"  {RC_MARK}\n'
    for rc in _rc_files():
        try:
            text = rc.read_text(encoding="utf-8") if rc.exists() else ""
            if RC_MARK not in text:
                with rc.open("a", encoding="utf-8") as f:
                    f.write(("\n" if text and not text.endswith("\n") else "") + line)
        except OSError:
            pass
    fish = HOME / ".config" / "fish" / "conf.d"
    if os.path.basename(os.environ.get("SHELL", "")) == "fish":
        fish.mkdir(parents=True, exist_ok=True)
        (fish / "tokenomics.fish").write_text(f"fish_add_path {d}  {RC_MARK}\n", encoding="utf-8")
    return path, True


def delete_later(path):
    """Windows: delete a file or folder a few seconds from now, from a detached process, for
    things in use by this very command (its .cmd launcher, the Python running it)."""
    rm = f'rmdir /s /q "{path}"' if Path(path).is_dir() else f'del /f /q "{path}"'
    subprocess.Popen(f"cmd /c ping -n 3 127.0.0.1 >nul & {rm}", stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=0x00000008 | 0x00000200)  # DETACHED_PROCESS | NEW_PROCESS_GROUP


def remove_launcher():
    for d in {HOME / ".local" / "bin", HOME / "bin", TK_HOME / "bin"}:
        for name in ("tokenomics", "tokenomics.cmd"):
            p = d / name
            if not p.is_file():
                continue
            if WINDOWS and name.endswith(".cmd"):
                # cmd.exe is still running this very file and re-reads it when Python exits, so
                # deleting it now makes cmd fail with "The batch file cannot be found".
                delete_later(p)
            else:
                p.unlink()
    for rc in [HOME / n for n in (".zshrc", ".bashrc", ".bash_profile", ".profile")]:
        try:
            text = rc.read_text(encoding="utf-8")
        except OSError:
            continue
        if RC_MARK in text:
            rc.write_text("".join(l for l in text.splitlines(True) if RC_MARK not in l), encoding="utf-8")
    fish = HOME / ".config" / "fish" / "conf.d" / "tokenomics.fish"
    if fish.is_file():
        fish.unlink()


# ---- commands -----------------------------------------------------------------------------------

def setup(args):
    want_plugin = "--no-plugin" not in args
    want_line = not ({"--no-statusline", "--no-statusbar"} & set(args))   # --no-statusbar: the old name
    found = [c for c in ("claude", "copilot") if has(c)]
    say("Setting up tokenomics")
    say("")
    if not found:
        say("  ! Neither Claude Code ('claude') nor GitHub Copilot CLI ('copilot') was found on PATH.")
        say("    Install one (https://claude.com/claude-code), then run: tokenomics setup")
    for cli in found:
        name = "Claude Code" if cli == "claude" else "Copilot CLI"
        if want_plugin:
            ok = claude_plugin("install") if cli == "claude" else copilot_plugin("install")
            if ok:
                say(f"  ✓ {name}: plugin installed (skills + hooks)")
            else:
                manual = (f"claude plugin marketplace add {REPO} && claude plugin install {PLUGIN}"
                          if cli == "claude" else f"copilot plugin install {REPO}")
                say(f"  ! {name}: couldn't add the plugin automatically. Run: {manual}")
        if want_line:
            import io
            import contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                sys.path.insert(0, str(HERE))
                import statusline
                statusline.migrate()                      # a pre-v1.4 "statusbar" install
                try:
                    statusline.install(cli, keep_existing=True)
                except SystemExit as e:                   # e.g. settings.json isn't valid JSON
                    print(f"Skipped {cli}: {e}")
            out = buf.getvalue()
            if "Skipped" in out:
                say(f"  · {name}: kept your existing status line (replace it with: tokenomics statusline --install {cli})")
            else:
                say(f"  ✓ {name}: statusline installed")
    remember_python()
    path, new_terminal = install_launcher()
    say(f"  ✓ 'tokenomics' command: {path}")
    say("")
    names = " / ".join("Claude Code" if c == "claude" else "Copilot CLI" for c in found)
    if found:
        say("Done! Next steps:")
        say(f"  1. Quit and reopen {names} (type /exit, then start it again).")
        say('  2. Ask it: "coach, review my prompts" or "spend report".')
        step = 3
        if "claude" in found:
            say("  3. Get updates automatically: in Claude Code open /plugin > Marketplaces > tokenomics")
            say("     and turn on auto-update.")
            step = 4
    else:
        say("Done (no assistant to connect yet). Next steps:")
        step = 1
    if new_terminal:
        say(f"  {step}. Open a new terminal window, then try: tokenomics dashboard --demo")
    else:
        say(f"  {step}. See where your tokens go: tokenomics dashboard --demo")
    return 0


def _download(dest):
    """Fetch REPO@REF into dest (replacing it). urllib first, then curl (some Pythons lack certs)."""
    url = f"https://github.com/{REPO}/archive/{REF}.tar.gz"
    tmp = Path(tempfile.mkdtemp(prefix="tokenomics-"))
    try:
        tgz = tmp / "src.tar.gz"
        try:
            import urllib.request
            with urllib.request.urlopen(url, timeout=60) as r, tgz.open("wb") as f:
                shutil.copyfileobj(r, f)
        except Exception:
            if not run(["curl", "-fsSL", "-o", str(tgz), url]):
                raise SystemExit(f"Couldn't download {url}. Check your connection and try again.")
        out = tmp / "src"
        with tarfile.open(tgz) as t:
            for m in t.getmembers():
                if m.name.startswith("/") or ".." in Path(m.name).parts or m.issym() or m.islnk():
                    raise SystemExit("Refusing an archive with unsafe paths.")
            if hasattr(tarfile, "data_filter"):
                t.extractall(out, filter="data")
            else:
                t.extractall(out)
        (top,) = [p for p in out.iterdir() if p.is_dir()]
        staged = dest.with_name(dest.name + ".new")
        shutil.rmtree(staged, ignore_errors=True)
        shutil.move(str(top), str(staged))
        shutil.rmtree(dest, ignore_errors=True)
        staged.rename(dest)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def update(args):
    say(f"Downloading the latest tokenomics ({REPO}@{REF})...")
    _download(APP_DIR)
    if has("claude"):
        say("  ✓ Claude Code plugin updated" if claude_plugin("update") else "  · Claude Code plugin: no update applied")
    if has("copilot"):
        say("  ✓ Copilot CLI plugin updated" if copilot_plugin("update") else "  · Copilot CLI plugin: no update applied")
    # Re-run setup from the fresh copy so the statusline, launcher and anything new are current.
    return subprocess.call([sys.executable, str(APP_DIR / "scripts" / "cli.py"), "setup", "--no-plugin", *args],
                           stdin=subprocess.DEVNULL)


def uninstall(args):
    sys.path.insert(0, str(HERE))
    import statusline
    for t in ("claude", "copilot"):
        if statusline._is_ours(statusline._status_line(t)):
            statusline.install(t, remove=True)
    if has("claude") and claude_plugin("uninstall"):
        say("Removed the Claude Code plugin.")
    if has("copilot") and copilot_plugin("uninstall"):
        say("Removed the Copilot CLI plugin.")
    remove_launcher()
    subprocess.run([sys.executable, str(HERE / "dashboard.py"), "--stop"], stdin=subprocess.DEVNULL,
                   capture_output=True)
    if "--purge" in args:
        shutil.rmtree(TK_HOME, ignore_errors=True)
        say(f"Deleted {TK_HOME} (all recorded data).")
    else:
        shutil.rmtree(APP_DIR, ignore_errors=True)
        runtime = TK_HOME / "runtime"                             # the private Python, if any
        if WINDOWS and runtime.is_dir():
            delete_later(runtime)                                 # it may be running this command
        else:
            shutil.rmtree(runtime, ignore_errors=True)
        for name in ("statusline.py", "statusbar.py", "model-prices.json", "python"):
            try:
                (TK_HOME / name).unlink()
            except OSError:
                pass
        say(f"tokenomics is uninstalled. Your recorded data is kept in {TK_HOME}; "
            f"delete that folder to remove it too.")
    return 0


def overview():
    say(__doc__.split("\n\n")[0])
    say("")
    for cli, name in (("claude", "Claude Code"), ("copilot", "Copilot CLI")):
        say(f"  {name:12} {'found' if has(cli) else 'not found'}")
    sys.stdout.flush()
    script("statusline.py", "--status")
    db = Path(os.environ.get("TOKENOMICS_DB", str(TK_HOME / "spendlens.db")))
    say(f"  data         {db if db.exists() else 'nothing recorded yet'}")
    say("")
    say("Commands: dashboard [--demo] · report · statusline · update · uninstall · setup")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    cmd, rest = (argv[0], argv[1:]) if argv else ("", [])
    if cmd in ("", "status", "doctor"):
        return overview()
    if cmd in ("-h", "--help", "help"):
        say(__doc__)
        return 0
    if cmd == "setup":
        return setup(rest)
    if cmd == "update":
        return update(rest)
    if cmd == "uninstall":
        return uninstall(rest)
    if cmd == "dashboard":
        fg = "--foreground" in rest
        rest = [a for a in rest if a != "--foreground"]
        if not fg and not any(a in ("--stop", "-h", "--help") for a in rest):
            rest = ["--background", *rest]
        return script("dashboard.py", *rest)
    if cmd == "report":
        return script("report.py", *rest)
    if cmd in ("statusline", "statusbar"):                # statusbar: the name before v1.4
        return script("statusline.py", *(rest or ["--status"]))
    if cmd in ("router", "pennywise"):
        if not rest or rest[0] not in ("serve", "explain", "env"):
            say("Usage: tokenomics router serve [--port N] | explain \"prompt\" | env [--port N]")
            return 2
        return script("pennywise.py", *rest)
    if cmd == "doggybag":
        return script("doggybag.py", "write", *rest)
    say(f"Unknown command: {cmd}. Run 'tokenomics help'.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
