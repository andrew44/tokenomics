#!/bin/sh
# tokenomics installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/andrew44/tokenomics/main/install.sh | sh
#
# Downloads tokenomics to ~/.tokenomics/app (no git needed), then sets up whichever assistants it
# finds: the Claude Code / Copilot CLI plugin (skills + hooks), the statusline, and a `tokenomics`
# command. It never replaces a status line you already have. Safe to run again to repair.
#
# No Python? It downloads a private copy into ~/.tokenomics/runtime (no admin rights, no pop-ups,
# nothing else on your system changes).
#
# Options (after `sh -s --`): --no-plugin  --no-statusline
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
        # A self-contained CPython build (python-build-standalone, as used by uv), pinned and
        # checked against its published SHA-256, unpacked into $home/runtime. No API calls, so no
        # rate limits.
        base="https://github.com/astral-sh/python-build-standalone/releases/download/20241016"
        case "$(uname -s)-$(uname -m)" in
            Darwin-arm64)              triple=aarch64-apple-darwin;      sum=4c18852bf9c1a11b56f21bcf0df1946f7e98ee43e9e4c0c5374b2b3765cf9508 ;;
            Darwin-x86_64)             triple=x86_64-apple-darwin;       sum=60c5271e7edc3c2ab47440b7abf4ed50fbc693880b474f74f05768f5b657045a ;;
            Linux-x86_64)              triple=x86_64-unknown-linux-gnu;  sum=43576f7db1033dd57b900307f09c2e86f371152ac8a2607133afa51cbfc36064 ;;
            Linux-aarch64|Linux-arm64) triple=aarch64-unknown-linux-gnu; sum=bba3c6be6153f715f2941da34f3a6a69c2d0035c9c5396bc5bb68c6d2bd1065a ;;
            *) return 1 ;;
        esac
        say "Downloading a private Python for tokenomics (one time, about 20 MB)..."
        fetch "$base/cpython-3.12.7%2B20241016-$triple-install_only.tar.gz" "$tmp/python.tar.gz" || return 1
        if command -v sha256sum >/dev/null 2>&1; then
            got="$(sha256sum "$tmp/python.tar.gz" | cut -d' ' -f1)"
        else
            got="$(shasum -a 256 "$tmp/python.tar.gz" | cut -d' ' -f1)"
        fi
        [ "$got" = "$sum" ] || { say "The Python download didn't match its checksum; not using it."; return 1; }
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

    # 3. Set everything up (plugin, statusline, `tokenomics` command)
    say ""
    "$py" "$app/scripts/cli.py" setup "$@" </dev/null
}

main "$@"
