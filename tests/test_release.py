"""The release workflow's version logic (.github/scripts/next_version.py)."""
import importlib.util
import json
import unittest

from helpers import ROOT

spec = importlib.util.spec_from_file_location("next_version", ROOT / ".github" / "scripts" / "next_version.py")
nv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nv)


class NextVersionTests(unittest.TestCase):
    def test_first_release_uses_the_manifest_version(self):
        self.assertEqual(nv.decide((1, 3, 0), None, True), ((1, 3, 0), False, True))

    def test_each_update_to_main_bumps_the_patch(self):
        self.assertEqual(nv.decide((1, 3, 0), "v1.3.0", True), ((1, 3, 1), True, True))
        self.assertEqual(nv.decide((1, 3, 4), "v1.3.4", True), ((1, 3, 5), True, True))

    def test_a_raised_manifest_version_is_released_as_is(self):
        self.assertEqual(nv.decide((1, 4, 0), "v1.3.7", True), ((1, 4, 0), False, True))
        self.assertEqual(nv.decide((2, 0, 0), "v1.9.9", False), ((2, 0, 0), False, True))

    def test_no_changes_no_release(self):
        self.assertEqual(nv.decide((1, 3, 0), "v1.3.0", False)[2], False)

    def test_versions_compare_numerically(self):
        self.assertGreater(nv.parse("v1.10.0"), nv.parse("v1.9.0"))
        with self.assertRaises(SystemExit):
            nv.parse("1.3")

    def test_manifests_agree_and_are_semver(self):
        versions = {json.loads(p.read_text())["version"] for p in nv.MANIFESTS}
        self.assertEqual(len(versions), 1, "bump .claude-plugin/plugin.json and plugin.json together")
        nv.parse(versions.pop())

    def test_write_changes_only_the_version(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "plugin.json"
            p.write_text('{\n  "name": "tokenomics",\n  "version": "1.3.0",\n  "x": "1.3.0"\n}\n')
            old = nv.MANIFESTS
            nv.MANIFESTS = [p]
            try:
                nv.write("1.3.1")
            finally:
                nv.MANIFESTS = old
            self.assertEqual(json.loads(p.read_text()), {"name": "tokenomics", "version": "1.3.1", "x": "1.3.0"})


if __name__ == "__main__":
    unittest.main()
