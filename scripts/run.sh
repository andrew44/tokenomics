#!/bin/sh
# Run a tokenomics script with a working Node.js 22.18+, on macOS, Linux and Windows (Git Bash).
#
#   sh scripts/run.sh spendlens.ts prompt claude-code
#
# tokenomics is TypeScript that Node.js runs directly (22.18+ strips the types itself; no build
# step, no packages). Claude Code runs hooks through bash, including on Windows. So: use the Node.js
# cached in ~/.tokenomics/node (written by the installer, or by the first successful probe here),
# else a private copy in ~/.tokenomics/runtime, then `node` on PATH, keeping the first that really
# is 22.18 or newer. stdin, stdout and the exit code pass straight through (hooks depend on all three).

here=$(cd "$(dirname "$0")" && pwd)
script="$here/$1"
shift
tk="${TOKENOMICS_HOME:-$HOME/.tokenomics}"
cache="$tk/node"
flags="--disable-warning=ExperimentalWarning"   # node:sqlite still says it is experimental on Node 22

# 22.18+ (type stripping on by default, node:sqlite built in)
ok='const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'

if [ -f "$cache" ]; then
    node=$(head -n 1 "$cache" | tr '\\' '/')       # C:\...\node.exe -> C:/.../node.exe
    if [ -n "$node" ] && [ -x "$node" ]; then
        exec "$node" $flags "$script" "$@"
    fi
fi

for private in "$tk/runtime/node/bin/node" "$tk/runtime/node/node.exe"; do
    if [ -x "$private" ]; then
        printf '%s\n' "$private" > "$cache" 2>/dev/null
        exec "$private" $flags "$script" "$@"
    fi
done

if command -v node >/dev/null 2>&1 && node -e "$ok" </dev/null >/dev/null 2>&1; then
    exe=$(node -p 'process.execPath' </dev/null 2>/dev/null)
    if [ -n "$exe" ]; then
        mkdir -p "$tk" 2>/dev/null && printf '%s\n' "$exe" | tr '\\' '/' > "$cache" 2>/dev/null
    fi
    exec node $flags "$script" "$@"
fi

echo "tokenomics: Node.js 22.18+ not found. Run the installer to get a private copy:" \
     "curl -fsSL https://raw.githubusercontent.com/andrew44/tokenomics/main/install.sh | sh" >&2
exit 0   # never block the assistant because Node.js is missing
