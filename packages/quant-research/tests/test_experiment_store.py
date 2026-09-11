from pathlib import Path
import json
import os
import tempfile
import unittest
import subprocess
import sys

from ngfi_quant.experiment_store import ExperimentStore, dispatch_research
from ngfi_quant.research_cli import demo_input


class ExperimentStoreTest(unittest.TestCase):
    def test_rejects_store_directories_writable_by_other_users(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / "unsafe"
            root.mkdir(mode=0o700)
            os.chmod(root, 0o777)
            with self.assertRaisesRegex(ValueError, "private"):
                ExperimentStore(root)

    def test_import_run_get_pagination_and_replay_identity(self):
        raw, spec = demo_input()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = ExperimentStore(root)
            imported = store.import_dataset(raw)
            self.assertEqual(imported, store.import_dataset(raw))
            result = store.run(imported["datasetId"], spec)
            self.assertEqual(result, store.run(imported["datasetId"], spec))
            page = store.get(result["runId"], "predictions", offset=2, limit=3)
            self.assertEqual(page["total"], 39)
            self.assertEqual(len(page["items"]), 3)
            self.assertEqual(store.get(result["runId"])["value"]["status"], "complete")
            self.assertEqual(store.list_runs()["runIds"], [result["runId"]])
            self.assertEqual(store.list_runs()["datasetIds"], [imported["datasetId"]])
            self.assertEqual(store.get(result["runId"], "factorSummary")["total"], 3)
            self.assertEqual(store.get(result["runId"], "correlations")["total"], 6)
            self.assertGreater(store.get(result["runId"], "modelDiagnostics")["value"]["samples"], 0)
            self.assertFalse((root / ".lock").exists())

    def test_tampered_content_traversal_and_symlink_are_rejected(self):
        raw, _ = demo_input()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = ExperimentStore(root / "safe")
            imported = store.import_dataset(raw)
            identity = imported["datasetId"]
            with self.assertRaisesRegex(ValueError, "sha256"):
                store.dataset("../../credentials")
            path = root / "safe" / "datasets" / f"{identity[7:]}.json"
            data = json.loads(path.read_text())
            data["content"]["provenance"] = "tampered"
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                store.dataset(identity)
            (root / "link").symlink_to(root / "safe", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlinks"):
                ExperimentStore(root / "link")

    def test_lock_conflicts_and_unknown_actions_fail_without_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = ExperimentStore(root)
            with store.writer():
                with self.assertRaisesRegex(ValueError, "locked"):
                    with store.writer():
                        self.fail("a second writer entered")
            with self.assertRaisesRegex(ValueError, "unsupported"):
                dispatch_research(root, {"action": "catalog", "command": "whoami"})
            self.assertEqual(dispatch_research(root, {"action": "list"})["total"], 0)
            self.assertIn("RETURN", [item["name"] for item in dispatch_research(root, {"action": "catalog"})["operators"]])
            schemas = dispatch_research(root, {"action": "schema"})
            self.assertIn("factors", schemas["spec"]["properties"])
            self.assertIn("FeatureObservation", schemas["dataset"]["$defs"])
            with self.assertRaisesRegex(ValueError, "missing parameters"):
                dispatch_research(root, {"action": "run"})

    def test_killed_writer_does_not_leave_a_stale_workspace_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            code = (
                "import sys,time\nfrom ngfi_quant.experiment_store import ExperimentStore\n"
                "with ExperimentStore(sys.argv[1]).writer():\n"
                " print('locked',flush=True)\n time.sleep(60)\n"
            )
            child = subprocess.Popen([sys.executable, "-c", code, str(root)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), "locked")
                with self.assertRaisesRegex(ValueError, "locked"):
                    with ExperimentStore(root).writer():
                        self.fail("concurrent writer entered")
                child.kill()
                child.wait(timeout=5)
                with ExperimentStore(root).writer():
                    self.assertTrue((root / ".writer.lock").is_file())
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)
