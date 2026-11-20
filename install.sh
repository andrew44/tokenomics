#!/bin/sh
# tokenomics installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/andrew44/tokenomics/main/install.sh | sh
#
# Downloads tokenomics to ~/.tokenomics/app (no git needed), then sets up whichever assistants it
# finds: the Claude Code / Copilot CLI plugin (skills + hooks), the statusline, and a `tokenomics`
# command. It never replaces a status line you already have. Safe to run again to repair.
#
# tokenomics is TypeScript run directly by Node.js 22.18 or newer (no build step, no npm install).
# No Node.js, or an older one? It downloads a private copy into ~/.tokenomics/runtime (no admin
# rights, no pop-ups, nothing else on your system changes).
#
# Options (after `sh -s --`): --no-plugin  --no-statusline
# Environment: TOKENOMICS_REPO (default andrew44/tokenomics), TOKENOMICS_REF (default main),
#              TOKENOMICS_HOME (default ~/.tokenomics),
#              TOKENOMICS_NODE (a node to use, or "standalone" to always use a private copy)

# Everything is inside main() so a half-downloaded script never runs.
main() {
    set -eu
    repo="${TOKENOMICS_REPO:-andrew44/tokenomics}"
    ref="${TOKENOMICS_REF:-main}"
    home="${TOKENOMICS_HOME:-$HOME/.tokenomics}"
    app="$home/app"
    private="$home/runtime/node/bin/node"

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

    usable() {  # usable NODE -> true if it is Node.js 22.18 or newer
        "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
            </dev/null >/dev/null 2>&1
    }

    standalone_node() {
        # The official Node.js 24 LTS build from nodejs.org, pinned and checked against its
        # published SHA-256, unpacked into $home/runtime. No API calls, so no rate limits.
        version=v24.22.2
        case "$(uname -s)-$(uname -m)" in
            Darwin-arm64)              plat=darwin-arm64; sum=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a ;;
            Darwin-x86_64)             plat=darwin-x64;   sum=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
            Linux-x86_64)              plat=linux-x64;    sum=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 ;;
            Linux-aarch64|Linux-arm64) plat=linux-arm64;  sum=95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2 ;;
            *) return 1 ;;
        esac
        say "Downloading a private Node.js for tokenomics (one time, about 50 MB)..."
        fetch "https://nodejs.org/dist/$version/node-$version-$plat.tar.gz" "$tmp/node.tar.gz" || return 1
        if command -v sha256sum >/dev/null 2>&1; then
            got="$(sha256sum "$tmp/node.tar.gz" | cut -d' ' -f1)"
        else
            got="$(shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1)"
        fi
        [ "$got" = "$sum" ] || { say "The Node.js download didn't match its checksum; not using it."; return 1; }
        rm -rf "$home/runtime"
        mkdir -p "$home/runtime"
        tar -xzf "$tmp/node.tar.gz" -C "$home/runtime" || return 1
        mv "$home/runtime/node-$version-$plat" "$home/runtime/node" || return 1
        [ -x "$private" ] && usable "$private"
    }

    tmp="$(mktemp -d 2>/dev/null || mktemp -d -t tokenomics)"
    trap 'rm -rf "$tmp"' EXIT INT TERM
    mkdir -p "$home"

    # 1. Node.js 22.18+ (built-in modules only; nothing gets npm-installed)
    node=""
    want="${TOKENOMICS_NODE:-}"
    if [ -n "$want" ] && [ "$want" != standalone ]; then
        usable "$want" || fail "TOKENOMICS_NODE=$want isn't a working Node.js 22.18+."
        node="$(command -v "$want")"
    elif [ -z "$want" ]; then
        if [ -x "$private" ] && usable "$private"; then
            node="$private"                                  # from an earlier install
        elif command -v node >/dev/null 2>&1 && usable node; then
            node="$(command -v node)"
        fi
    fi
    if [ -z "$node" ]; then
        if standalone_node; then
            node="$private"
        else
            case "$(uname -s)" in
                Darwin) hint="install it from https://nodejs.org (or: brew install node)" ;;
                *)      hint="install it from https://nodejs.org or with your package manager" ;;
            esac
            fail "tokenomics needs Node.js 22.18 or newer and couldn't download it. Please $hint, then run this installer again."
        fi
    fi

    # 2. Download tokenomics (a tarball, so git isn't needed)
    url="https://github.com/$repo/archive/$ref.tar.gz"
    say "Downloading tokenomics ($repo@$ref)..."
    fetch "$url" "$tmp/src.tar.gz" || fail "download failed: $url  (check your internet connection and try again)"
    mkdir -p "$tmp/src"
    tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" || fail "couldn't unpack the download."
    src="$(find "$tmp/src" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [ -f "$src/scripts/cli.ts" ] || fail "the download doesn't look like tokenomics."
    rm -rf "$app.new"
    mv "$src" "$app.new"
    rm -rf "$app"
    mv "$app.new" "$app"

    # 3. Set everything up (plugin, statusline, `tokenomics` command)
    say ""
    "$node" --disable-warning=ExperimentalWarning "$app/scripts/cli.ts" setup "$@" </dev/null
}

main "$@"
