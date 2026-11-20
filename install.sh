#!/bin/sh
# tokenomics installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/andrew44/tokenomics/main/install.sh | sh
#
# Downloads tokenomics to ~/.tokenomics/app (no git needed), then sets up whichever assistants it
# finds: the Claude Code / Copilot CLI plugin (skills + hooks), the status bar, and a `tokenomics`
# command. It never replaces a status line you already have. Safe to run again to repair.
#
# No Python? It downloads a private copy into ~/.tokenomics/runtime (no admin rights, no pop-ups,
# nothing else on your system changes).
#
# Options (after `sh -s --`): --no-plugin  --no-statusbar
# Environment: TOKENOMICS_REPO (default andrew44/tokenomics), TOKENOMICS_REF (default main),
#              TOKENOMICS_HOME (default ~/.tokenomics),
#              TOKENOMICS_PYTHON (a python to use, or "standalone" to always use a private copy)

# Everything is inside main() so a half-downloaded script never runs.
main() {
    set -eu
    repo="${TOKENOMICS_REPO:-andrew44/tokenomics}"
    ref="${TOKENOMICS_REF:-main}"
    home="${TOKENOMICS_HOME:-$HOME/.tokenomics}"
    app="$home/app"

    say() { printf '%s\n' "$*"; }
    fail() { printf '\ntokenomics: %s\n' "$*" >&2; exit 1; }

    fetch() {   # fetch URL FILE
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL --retry 3 "$1" -o "$2"
        elif command -v wget >/dev/null 2>&1; then
            wget -q "$1" -O "$2"
        else
            fail "curl or wget is needed to download tokenomics."
        fi
    }

    usable() {  # usable PYTHON -> true if it is a real Python 3.8+
        # On a Mac without the developer tools, /usr/bin/python3 is a placeholder that pops up an
        # "install developer tools" dialog instead of running. Don't touch it.
        if [ "$(uname -s)" = Darwin ] && [ "$(command -v "$1")" = /usr/bin/python3 ] \
            && ! xcode-select -p >/dev/null 2>&1; then
            return 1
        fi
        "$1" -c 'import sys; sys.exit(sys.version_info < (3, 8))' </dev/null >/dev/null 2>&1
    }

    standalone_python() {
        # A self-contained CPython build (python-build-standalone, as used by uv), unpacked into
        # $home/runtime. Picks the newest 3.12 "install_only" build for this OS and CPU.
        case "$(uname -s)-$(uname -m)" in
            Darwin-arm64)              triple=aarch64-apple-darwin ;;
            Darwin-x86_64)             triple=x86_64-apple-darwin ;;
            Linux-x86_64)              triple=x86_64-unknown-linux-gnu ;;
            Linux-aarch64|Linux-arm64) triple=aarch64-unknown-linux-gnu ;;
            *) return 1 ;;
        esac
        fetch "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest" "$tmp/rel.json" || return 1
        url="$(grep -oE "https://[^\"]*cpython-3\.12\.[0-9]+(\+|%2B)[0-9]+-$triple-install_only\.tar\.gz" "$tmp/rel.json" | head -n 1)"
        [ -n "$url" ] || return 1
        say "Downloading a private Python for tokenomics (one time, about 20 MB)..."
        fetch "$url" "$tmp/python.tar.gz" || return 1
        rm -rf "$home/runtime"
        mkdir -p "$home/runtime"
        tar -xzf "$tmp/python.tar.gz" -C "$home/runtime" || return 1
        [ -x "$home/runtime/python/bin/python3" ] && usable "$home/runtime/python/bin/python3"
    }

    tmp="$(mktemp -d 2>/dev/null || mktemp -d -t tokenomics)"
    trap 'rm -rf "$tmp"' EXIT INT TERM
    mkdir -p "$home"

    # 1. Python 3.8+ (standard library only; nothing gets pip-installed)
    py=""
    want="${TOKENOMICS_PYTHON:-}"
    if [ -n "$want" ] && [ "$want" != standalone ]; then
        usable "$want" || fail "TOKENOMICS_PYTHON=$want isn't a working Python 3.8+."
        py="$(command -v "$want")"
    elif [ -z "$want" ]; then
        if [ -x "$home/runtime/python/bin/python3" ] && usable "$home/runtime/python/bin/python3"; then
            py="$home/runtime/python/bin/python3"            # from an earlier install
        fi
        for c in python3 python; do
            [ -z "$py" ] || break
            if command -v "$c" >/dev/null 2>&1 && usable "$c"; then
                py="$(command -v "$c")"
            fi
        done
    fi
    if [ -z "$py" ]; then
        if standalone_python; then
            py="$home/runtime/python/bin/python3"
        else
            case "$(uname -s)" in
                Darwin) hint="install it from https://www.python.org/downloads/ (or: brew install python)" ;;
                *)      hint="install it with your package manager, e.g.: sudo apt install python3" ;;
            esac
            fail "tokenomics needs Python 3.8 or newer and couldn't download it. Please $hint, then run this installer again."
        fi
    fi

    # 2. Download tokenomics (a tarball, so git isn't needed)
    url="https://github.com/$repo/archive/$ref.tar.gz"
    say "Downloading tokenomics ($repo@$ref)..."
    fetch "$url" "$tmp/src.tar.gz" || fail "download failed: $url  (check your internet connection and try again)"
    mkdir -p "$tmp/src"
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
