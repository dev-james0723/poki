import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "bin/native-build-receipt.py"
SPEC = importlib.util.spec_from_file_location("native_build_receipt", SCRIPT)
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)


class NativeBuildReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "source"
        self.root.mkdir()
        for name in receipt.REQUIRED:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name + "\n")
        self.prepared = self.root / "build/proof/prepared.json"
        self.output = self.root / "build/proof/receipt.json"

    def candidate(self, build_id, feature=True):
        path = self.root / "build/candidate"
        runtime = {"build_id": build_id, "pid": 123, "version": "0.1.0",
                   "features": ["native_execution_v1"] if feature else []}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!" + sys.executable + "\nimport json, sys\n"
                        "assert sys.argv[1:] == ['--build-info']\n"
                        "print(" + repr(json.dumps({"native_runtime": runtime})) + ")\n")
        path.chmod(0o700)
        return path

    def test_source_hash_is_stable_and_covers_local_dependency(self):
        first = receipt.source_snapshot(self.root)
        self.assertEqual(first, receipt.source_snapshot(self.root))
        generated = self.root / ".deps/idevice/target/debug/output"
        generated.parent.mkdir(parents=True)
        generated.write_text("compiled output")
        self.assertEqual(first, receipt.source_snapshot(self.root))
        (self.root / ".deps/idevice/idevice/src").mkdir()
        (self.root / ".deps/idevice/idevice/src/lib.rs").write_text("changed source")
        self.assertNotEqual(first["build_id"], receipt.source_snapshot(self.root)["build_id"])

    def test_finished_receipt_binds_source_and_actual_binary(self):
        prepared = receipt.prepare(self.root, self.prepared)
        binary = self.candidate(prepared["build_id"])
        result = receipt.finish(self.root, self.prepared, binary, self.output)
        proof = json.loads(self.output.read_text())
        self.assertEqual(result["binary_sha256"], receipt.digest_file(binary))
        self.assertEqual(proof["native_runtime"]["build_id"], prepared["build_id"])
        self.assertEqual(proof["prepared_manifest"]["files"], receipt.source_snapshot(self.root)["files"])
        self.assertEqual(stat.S_IMODE(self.prepared.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)

    def test_source_drift_and_wrong_binary_fail_closed(self):
        prepared = receipt.prepare(self.root, self.prepared)
        binary = self.candidate("unversioned")
        with self.assertRaisesRegex(ValueError, "POKI_BUILD_ID"):
            receipt.finish(self.root, self.prepared, binary, self.output)
        self.assertFalse(self.output.exists())
        binary = self.candidate(prepared["build_id"])
        (self.root / "native/bridge/src/main.rs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            receipt.finish(self.root, self.prepared, binary, self.output)
        self.assertFalse(self.output.exists())

    def test_missing_capability_fails_closed(self):
        prepared = receipt.prepare(self.root, self.prepared)
        binary = self.candidate(prepared["build_id"], feature=False)
        with self.assertRaisesRegex(ValueError, "lacks native_execution_v1"):
            receipt.finish(self.root, self.prepared, binary, self.output)

    def test_internal_file_symlink_records_spelling_and_resolved_content(self):
        target = self.root / ".deps/idevice/README.md"
        target.write_text("source documentation")
        link = self.root / ".deps/idevice/idevice/README.md"
        link.symlink_to("../README.md")
        first = receipt.source_snapshot(self.root)
        entry = next(item for item in first["files"]
                     if item["path"] == ".deps/idevice/idevice/README.md")
        self.assertEqual(entry["symlink_target"], "../README.md")
        self.assertEqual(entry["resolved_path"], ".deps/idevice/README.md")
        self.assertEqual(entry["sha256"], receipt.digest_file(target))
        self.assertEqual(entry["bytes"], target.stat().st_size)
        self.assertEqual(entry["mode"], stat.S_IMODE(target.stat().st_mode))
        link.unlink()
        link.symlink_to(".././README.md")
        second = receipt.source_snapshot(self.root)
        self.assertNotEqual(first["build_id"], second["build_id"])
        target.write_text("changed documentation")
        self.assertNotEqual(second["build_id"], receipt.source_snapshot(self.root)["build_id"])

    def test_external_dangling_directory_and_cyclic_links_fail_closed(self):
        outside = Path(self.directory.name) / "outside"
        outside.write_text("not a declared source input")
        link = self.root / "native/bridge/src/link"
        cases = ((outside, "escapes declared source tree"),
                 ("missing.rs", "dangling or cyclic"),
                 (self.root / "native/bridge/src", "directory symlink"),
                 ("link", "dangling or cyclic"))
        for target, message in cases:
            with self.subTest(target=str(target)):
                link.symlink_to(target)
                try:
                    with self.assertRaisesRegex(ValueError, message):
                        receipt.source_snapshot(self.root)
                finally:
                    link.unlink()

    def test_receipts_are_exclusive_and_cannot_pollute_source_inputs(self):
        with self.assertRaisesRegex(ValueError, "outside source trees"):
            receipt.prepare(self.root, self.root / "native/bridge/receipt.json")
        receipt.prepare(self.root, self.prepared)
        with self.assertRaises(FileExistsError):
            receipt.prepare(self.root, self.prepared)


if __name__ == "__main__":
    unittest.main()
