"""Context diet: catch tool calls that would pour a lot of low-value text into the context.

Platform-independent. Input is a normalised ToolCall (adapters map Read/view and Bash/shell
onto TOOL_READ and TOOL_SHELL). Output is a Verdict with a reason written for the model:
the hook denies the call and the model retries with a narrower one (a range, a filter, a
--tail), which is almost always what a person would want anyway.

Rules are deliberately conservative: a command that already pipes, redirects or limits its
output is left alone, and files that cannot be found are never blocked.
"""
from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .evidence import TOOL_READ, TOOL_SHELL, ToolCall

BYPASS = "# diet-ok"
LOCKFILES = {"package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
             "poetry.lock", "pipfile.lock", "uv.lock", "cargo.lock", "gemfile.lock", "composer.lock",
             "go.sum", "packages.lock.json", "podfile.lock", "flake.lock"}
GENERATED_RE = re.compile(r"\.(min\.(js|css|mjs)|map|bundle\.js|chunk\.js|pb\.go|snap)$", re.I)
SEGMENT_SPLIT = re.compile(r"&&|\|\||;|\n")


@dataclass
class Verdict:
    rule: str
    reason: str                 # shown to the model (and the user in warn mode)
    est_tokens: Optional[int]   # rough size of what was avoided, when knowable


def max_bytes() -> int:
    try:
        return max(1, int(os.environ.get("TOKENOMICS_DIET_MAX_KB", "64"))) * 1024
    except ValueError:
        return 64 * 1024


def _size(path: str, cwd: Optional[str]) -> Optional[int]:
    try:
        p = Path(os.path.expanduser(path))
        if not p.is_absolute() and cwd:
            p = Path(cwd) / p
        return p.stat().st_size if p.is_file() else None
    except (OSError, ValueError):
        return None


def _generated(name: str) -> bool:
    base = os.path.basename(name).lower()
    return base in LOCKFILES or bool(GENERATED_RE.search(base))


def check(call: ToolCall, cwd: Optional[str] = None) -> Optional[Verdict]:
    if call.kind == TOOL_READ:
        return _check_read(call, cwd)
    if call.kind == TOOL_SHELL:
        return _check_shell(call.command or "", cwd)
    return None


# ---- reads ------------------------------------------------------------------------------

def _check_read(call: ToolCall, cwd: Optional[str]) -> Optional[Verdict]:
    if not call.path or call.ranged:
        return None
    size = _size(call.path, cwd)
    if size is None or size < max_bytes() or not _generated(call.path):
        return None
    name = os.path.basename(call.path)
    return Verdict("generated-file", (
        f"tokenomics diet: {name} is a generated file of about {size // 4:,} tokens; reading it whole "
        f"is rarely useful. Search it instead (e.g. grep for the package or symbol you need), or read "
        f"a small range with offset/limit."), size // 4)


# ---- shell commands -----------------------------------------------------------------------

def _words(segment: str) -> Optional[List[str]]:
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return None


def _has(words: List[str], *flags: str) -> bool:
    for w in words:
        for f in flags:
            if w == f or (f.startswith("--") and w.startswith(f + "=")):
                return True
            if not f.startswith("--") and len(f) == 2 and w.startswith(f) and w[2:].isdigit():
                return True                           # -n50
    return False


def _short_flag(words: List[str], letter: str) -> bool:
    return any(w.startswith("-") and not w.startswith("--") and letter in w[1:] for w in words)


def _verb(words: List[str]) -> str:
    """First positional word after the command, skipping global flags (`kubectl -n prod logs`)."""
    skip = False
    for w in words[1:]:
        if skip:
            skip = False
            continue
        if w.startswith("-"):
            skip = "=" not in w and w in ("-n", "--namespace", "--context", "--kubeconfig", "-c", "--cluster")
            continue
        return w
    return ""


def _check_shell(command: str, cwd: Optional[str]) -> Optional[Verdict]:
    if BYPASS in command:
        return None
    for seg in SEGMENT_SPLIT.split(command):
        seg = seg.strip()
        if not seg or "|" in seg or ">" in seg:       # already filtered or sent to a file
            continue
        words = _words(seg)
        if not words:
            continue
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):   # FOO=1 cmd ...
            words = words[1:]
        while words and words[0] in ("sudo", "time", "nice", "command"):
            words = words[1:]
        if not words:
            continue
        v = _shell_rule(words, cwd)
        if v:
            v.reason += f" If you really need the full output, append `{BYPASS}` to the command."
            return v
    return None


def _shell_rule(w: List[str], cwd: Optional[str]) -> Optional[Verdict]:
    cmd = os.path.basename(w[0])
    sub = w[1] if len(w) > 1 else ""

    if cmd in ("kubectl", "oc") and _verb(w) == "logs":
        if not _has(w, "--tail", "--since", "--since-time", "-f", "--follow"):
            return Verdict("unbounded-logs", "tokenomics diet: `kubectl logs` without a limit can return "
                           "thousands of lines. Add `--tail=200` or `--since=15m` (and grep for the error).", None)
    if (cmd in ("docker", "podman") and (sub == "logs" or (sub == "compose" and "logs" in w))) or \
            (cmd == "docker-compose" and sub == "logs"):
        if not _has(w, "--tail", "-n", "--since", "-f", "--follow"):
            return Verdict("unbounded-logs", "tokenomics diet: container logs without a limit can be huge. "
                           "Add `--tail 200` or `--since 15m`.", None)
    if cmd == "journalctl" and not _has(w, "-n", "--lines", "--since", "-S", "--until", "-f", "--follow"):
        return Verdict("unbounded-logs", "tokenomics diet: `journalctl` without a limit dumps the whole "
                       "journal. Add `-n 200` or `--since '15 min ago'` (and `-u <unit>`).", None)
    if cmd == "git" and sub in ("log", "reflog"):
        bounded = _has(w, "-n", "--max-count", "--since", "--after", "--until") or \
            any(re.match(r"^-\d+$", x) or ".." in x for x in w[2:])
        if not bounded:
            return Verdict("unbounded-git-log", "tokenomics diet: `git log` without a limit prints the whole "
                           "history. Add `-n 20` (and `--oneline` unless you need full messages).", None)
    if cmd == "find" and len(w) > 1 and w[1] in ("/", "~", os.path.expanduser("~")) and not _has(w, "-maxdepth"):
        return Verdict("unbounded-find", "tokenomics diet: `find` from / or ~ walks the whole disk. Start from "
                       "the project folder, add `-maxdepth 3`, or pipe to `head`.", None)
    if cmd == "ls" and (_short_flag(w, "R") or "--recursive" in w):
        return Verdict("recursive-listing", "tokenomics diet: a recursive `ls` lists every file (node_modules, "
                       ".git ...). Use `git ls-files`, `find . -maxdepth 2`, or a Glob pattern.", None)
    if cmd == "tree" and not _has(w, "-L"):
        return Verdict("recursive-listing", "tokenomics diet: `tree` without `-L` prints every file. "
                       "Add `-L 2` (and `-I node_modules`).", None)
    if cmd in ("cat", "less", "more", "bat"):
        for arg in w[1:]:
            if arg.startswith("-"):
                continue
            size = _size(arg, cwd)
            if size is None or size < max_bytes():
                continue
            kind = "a generated file" if _generated(arg) else "a large file"
            return Verdict("large-cat", f"tokenomics diet: {os.path.basename(arg)} is {kind} of about "
                           f"{size // 4:,} tokens. Use `grep -n`, `head`/`tail`, or `sed -n 'A,Bp'` to read "
                           f"only the part you need.", size // 4)
    return None
