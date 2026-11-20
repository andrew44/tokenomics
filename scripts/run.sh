#!/bin/sh
# Run a tokenomics script with a working Python 3.8+, on macOS, Linux and Windows (Git Bash).
#
#   sh scripts/run.sh spendlens.py prompt claude-code
#
# Claude Code runs hooks through bash, including on Windows, where `python3` is usually missing or
# is the Microsoft Store stub that can't run anything. So: use the interpreter cached in
# ~/.tokenomics/python (written by the installer, or by the first successful probe here), else try
# python3, python and `py -3`, keeping the first that really is Python 3.8+.
# stdin, stdout and the exit code pass straight through (hooks depend on all three).

here=$(cd "$(dirname "$0")" && pwd)
script="$here/$1"
shift
cache="${TOKENOMICS_HOME:-$HOME/.tokenomics}/python"

if [ -f "$cache" ]; then
    py=$(head -n 1 "$cache" | tr '\\' '/')   # C:\...\python.exe -> C:/.../python.exe
    if [ -n "$py" ] && [ -x "$py" ]; then
        exec "$py" "$script" "$@"
    fi
fi

ok='import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'
for cand in python3 python "py -3"; do
    bin=${cand%% *}
    command -v "$bin" >/dev/null 2>&1 || continue
    # shellcheck disable=SC2086  # "py -3" must split into command + flag
    if $cand -c "$ok" </dev/null >/dev/null 2>&1; then
        exe=$($cand -c 'import sys; print(sys.executable)' </dev/null 2>/dev/null)
        if [ -n "$exe" ]; then
            mkdir -p "$(dirname "$cache")" 2>/dev/null && printf '%s\n' "$exe" | tr '\\' '/' > "$cache" 2>/dev/null
        fi
        # shellcheck disable=SC2086
        exec $cand "$script" "$@"
    fi
done

echo "tokenomics: Python 3.8+ not found; install it from https://www.python.org/downloads/" >&2
exit 0   # never block the assistant because Python is missing
