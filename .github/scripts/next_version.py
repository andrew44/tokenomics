#!/usr/bin/env python3
"""Work out the next release version and keep the plugin manifests in step with it.

  next_version.py            print KEY=VALUE lines for $GITHUB_OUTPUT:
                               version=1.3.1   tag=v1.3.1   bump=true|false   release=true|false
  next_version.py --write V  set "version" in every manifest to V

Rules (the manifests are the source of truth; tags are vX.Y.Z):
  * No release yet                    -> release the manifest version as it is.
  * You raised the manifest version   -> release that version as it is (how you do minor/major).
  * Otherwise                         -> bump the patch of the latest release, and the workflow
                                         commits that to the manifests (bump=true), because Claude
                                         Code only sends a plugin update when the version changes.
  * Nothing new since the last tag    -> release=false.
Stdlib only.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFESTS = [ROOT / ".claude-plugin" / "plugin.json", ROOT / "plugin.json"]
VERSION_RE = re.compile(r'("version"\s*:\s*")([^"]+)(")')


def parse(v):
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", v.strip())
    if not m:
        raise SystemExit(f"Not a MAJOR.MINOR.PATCH version: {v!r}")
    return tuple(int(x) for x in m.groups())


def fmt(t):
    return ".".join(str(x) for x in t)


def manifest_version():
    versions = {json.loads(p.read_text(encoding="utf-8"))["version"] for p in MANIFESTS}
    if len(versions) != 1:
        raise SystemExit(f"The manifests disagree on the version: {sorted(versions)}. Make them match.")
    return parse(versions.pop())


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def latest_tag():
    tags = [t for t in git("tag", "--list", "v*").splitlines() if re.fullmatch(r"v\d+\.\d+\.\d+", t)]
    return max(tags, key=parse) if tags else None


def decide(manifest, tag, changed):
    """(version, bump, release) from the manifest version, the latest tag and whether anything
    changed since that tag."""
    if tag is None:
        return manifest, False, True
    last = parse(tag)
    if manifest > last:
        return manifest, False, True
    if not changed:
        return last, False, False
    return (last[0], last[1], last[2] + 1), True, True


def write(version):
    for p in MANIFESTS:
        text = p.read_text(encoding="utf-8")
        new, n = VERSION_RE.subn(lambda m: m.group(1) + version + m.group(3), text, count=1)
        if n != 1:
            raise SystemExit(f"No version field in {p}")
        p.write_text(new, encoding="utf-8")


def main(argv):
    if argv[:1] == ["--write"]:
        write(fmt(parse(argv[1])))
        return 0
    tag = latest_tag()
    changed = tag is None or bool(git("rev-list", f"{tag}..HEAD"))
    version, bump, release = decide(manifest_version(), tag, changed)
    print(f"version={fmt(version)}\ntag=v{fmt(version)}\nbump={str(bump).lower()}\n"
          f"release={str(release).lower()}\nprevious={tag or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
