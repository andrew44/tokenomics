#!/bin/sh
# tokenomics installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/andrew44/tokenomics/main/install.sh | sh
#
# Downloads tokenomics to ~/.tokenomics/app (no git needed), then sets up whichever assistants it
# finds: the Claude Code / Copilot CLI plugin (skills + hooks), the status bar, and a `tokenomics`
# command. It never replaces a status line you already have. Safe to run again to repair.
#
# Options (after `sh -s --`): --no-plugin  --no-statusbar
# Environment: TOKENOMICS_REPO (default andrew44/tokenomics), TOKENOMICS_REF (default main),
#              TOKENOMICS_HOME (default ~/.tokenomics)

# Everything is inside main() so a half-downloaded script never runs.
main() {
    set -eu
    repo="${TOKENOMICS_REPO:-andrew44/tokenomics}"
    ref="${TOKENOMICS_REF:-main}"
    home="${TOKENOMICS_HOME:-$HOME/.tokenomics}"
    app="$home/app"

    say() { printf '%s\n' "$*"; }
    fail() { printf 'tokenomics: %s\n' "$*" >&2; exit 1; }

    # 1. Python 3.8+ (standard library only; nothing gets pip-installed)
    py=""
    for c in python3 python; do
        if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
            py="$(command -v "$c")"
            break
        fi
    done
    if [ -z "$py" ]; then
        case "$(uname -s)" in
            Darwin) hint="run: xcode-select --install   (or: brew install python)" ;;
            *)      hint="install it with your package manager, e.g.: sudo apt install python3" ;;
        esac
        fail "Python 3.8 or newer is needed. To get it, $hint  -- then run this installer again."
    fi

    # 2. Download (a tarball, so git isn't needed)
    url="https://github.com/$repo/archive/$ref.tar.gz"
    say "Downloading tokenomics ($repo@$ref)..."
    tmp="$(mktemp -d 2>/dev/null || mktemp -d -t tokenomics)"
    trap 'rm -rf "$tmp"' EXIT INT TERM
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$tmp/src.tar.gz" || fail "download failed: $url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$tmp/src.tar.gz" "$url" || fail "download failed: $url"
    else
        fail "curl or wget is needed to download tokenomics."
    fi
    mkdir -p "$tmp/src" "$home"
    tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" || fail "couldn't unpack the download."
    src="$(find "$tmp/src" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [ -f "$src/scripts/cli.py" ] || fail "the download doesn't look like tokenomics."
    rm -rf "$app.new"
    mv "$src" "$app.new"
    rm -rf "$app"
    mv "$app.new" "$app"

    # 3. Set everything up (plugin, status bar, `tokenomics` command)
    say ""
    "$py" "$app/scripts/cli.py" setup "$@" </dev/null
}

main "$@"
