#!/usr/bin/env python3
"""Run the prebuilt lab image; always remove exactly this invocation's container."""

import json
import re
import subprocess
import uuid


IMAGE = "ssterm-mosh-fixture:sst-038"


def docker(args, timeout=20):
    return subprocess.run(["docker"] + args, capture_output=True, timeout=timeout)


def main():
    owner = str(uuid.uuid4())
    name = "ssterm-mosh-" + owner
    label = "dev.ssterm.mosh.probe=" + owner
    receipt = {"fixtureOwner": owner, "ok": False}
    container_id = None
    try:
        identity = docker(["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", IMAGE])
        if identity.returncode:
            raise RuntimeError("image-inspect-failed")
        receipt["imageIdentity"] = identity.stdout.decode().strip()
        created = docker(["create", "--name", name, "--label", label, "--network", "none", IMAGE])
        if created.returncode:
            raise RuntimeError("container-create-failed")
        candidate = created.stdout.decode().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", candidate):
            raise RuntimeError("container-identity-invalid")
        container_id = candidate
        result = docker(["start", "--attach", container_id], timeout=110)
        # The image emits one sanitized JSON line. Raw terminal streams never leave it.
        receipt["probe"] = json.loads(result.stdout)
        if not isinstance(receipt["probe"], dict):
            raise ValueError("invalid-receipt")
        receipt["ok"] = result.returncode == 0 and receipt["probe"].get("ok") is True
    except subprocess.TimeoutExpired:
        receipt["failure"] = "lab-timeout"
    except (RuntimeError, ValueError, OSError):
        receipt["failure"] = "lab-infrastructure-failure"
    finally:
        try:
            removed_ok = container_id is None
            if container_id:
                ownership = docker(["inspect", "--format", '{{index .Config.Labels "dev.ssterm.mosh.probe"}}', container_id])
                if ownership.returncode == 0 and ownership.stdout.decode().strip() == owner:
                    removed_ok = docker(["rm", "--force", container_id]).returncode == 0
            leftovers = docker(["ps", "--all", "--quiet", "--filter", "label=" + label])
            receipt["ownedContainerRemoved"] = removed_ok and leftovers.returncode == 0 and not leftovers.stdout.strip()
        except (subprocess.TimeoutExpired, OSError):
            receipt["ownedContainerRemoved"] = False
        receipt["ok"] = receipt["ok"] and receipt["ownedContainerRemoved"]
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
