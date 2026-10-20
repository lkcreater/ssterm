"""Ownership regression tests; no Docker daemon or network is contacted."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("mosh_probe_runner", Path(__file__).with_name("run.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class OwnershipTests(unittest.TestCase):
    def invoke(self, create_ok=True, correct_owner=True, valid_id=True):
        owner = "test-owner"
        container_id = "a" * 64
        calls = []

        def fake_docker(args, timeout=20):
            calls.append(args)
            code, output = 0, b""
            if args[:2] == ["image", "inspect"]:
                output = b"sha256:test linux/arm64"
            elif args[0] == "create":
                code = 0 if create_ok else 1
                output = (container_id if valid_id else "not-an-id").encode()
            elif args[0] == "start":
                output = b'{"ok":true}'
            elif args[0] == "inspect":
                output = (owner if correct_owner else "somebody-else").encode()
            return subprocess.CompletedProcess(args, code, stdout=output, stderr=b"")

        buffer = io.StringIO()
        with patch.object(runner.uuid, "uuid4", return_value=owner), patch.object(runner, "docker", side_effect=fake_docker), contextlib.redirect_stdout(buffer):
            status = runner.main()
        return status, json.loads(buffer.getvalue()), calls

    def test_create_collision_never_removes_named_container(self):
        status, receipt, calls = self.invoke(create_ok=False)
        self.assertEqual(status, 1)
        self.assertFalse(any(call[0] == "rm" for call in calls))

    def test_mismatched_ownership_never_removes_container(self):
        status, receipt, calls = self.invoke(correct_owner=False)
        self.assertEqual(status, 1)
        self.assertFalse(receipt["ownedContainerRemoved"])
        self.assertFalse(any(call[0] == "rm" for call in calls))

    def test_invalid_create_identity_never_starts_or_removes(self):
        status, receipt, calls = self.invoke(valid_id=False)
        self.assertEqual(status, 1)
        self.assertFalse(any(call[0] in ["rm", "start"] for call in calls))

    def test_success_removes_only_verified_owned_id(self):
        status, receipt, calls = self.invoke()
        self.assertEqual(status, 0)
        self.assertTrue(receipt["ownedContainerRemoved"])
        self.assertEqual([call for call in calls if call[0] == "rm"], [["rm", "--force", "a" * 64]])


if __name__ == "__main__":
    unittest.main()
