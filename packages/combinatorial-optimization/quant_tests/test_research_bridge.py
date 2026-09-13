import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ngfi_quant.research_bridge import artifact_computation, compute_research


class ResearchBridgeTest(unittest.TestCase):
    def test_operator_json_keeps_duplicate_and_nonfinite_rejections(self):
        self.assertEqual(compute_research("parse-json", {"text": '{"value":1}'}), {"value": 1})
        for text in ('{"x":1,"x":2}', '{"x":NaN}', '[]'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                compute_research("parse-json", {"text": text})

    def test_private_transport_verifies_bytes_and_fixed_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            body = b"{}"
            (root / "input.json").write_bytes(body)
            with patch.dict(os.environ, {"NGFI_QUANT_TRANSPORT": str(root)}):
                receipt = artifact_computation({"operation": "catalog", "inputHash": "sha256:" + hashlib.sha256(body).hexdigest()})
            output = (root / "output.json").read_bytes()
            self.assertEqual(receipt["hash"], "sha256:" + hashlib.sha256(output).hexdigest())
            self.assertEqual(receipt["bytes"], len(output))
            self.assertEqual(len(json.loads(output)["operators"]), 17)

    def test_tampered_input_duplicate_keys_and_nonfinite_json_reject(self):
        for body, digest in ((b"{}", "0" * 64), (b'{"x":1,"x":2}', None), (b'{"x":NaN}', None)):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                (root / "input.json").write_bytes(body)
                with patch.dict(os.environ, {"NGFI_QUANT_TRANSPORT": str(root)}), self.assertRaises(ValueError):
                    artifact_computation({"operation": "catalog", "inputHash": "sha256:" + (digest or hashlib.sha256(body).hexdigest())})

    def test_symlink_and_world_accessible_transport_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "other").write_bytes(b"{}")
            (root / "input.json").symlink_to(root / "other")
            request = {"operation": "catalog", "inputHash": "sha256:" + hashlib.sha256(b"{}").hexdigest()}
            with patch.dict(os.environ, {"NGFI_QUANT_TRANSPORT": str(root)}), self.assertRaises(OSError):
                artifact_computation(request)
            root.chmod(0o755)
            with patch.dict(os.environ, {"NGFI_QUANT_TRANSPORT": str(root)}), self.assertRaisesRegex(ValueError, "private"):
                artifact_computation(request)
