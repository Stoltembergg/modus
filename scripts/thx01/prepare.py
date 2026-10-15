"""Development-only download of the fixed THX-01 snapshot; never used by Modus."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

REVISION = "01262517979528a0103108ba473b78d6baeec016"
WEIGHT_SHA256 = "52ce834b2a4d265fbc351338655977023ddb61b0363f5f6a4fd096e6c70154b0"
BASE = "https://huggingface.co"


def prepare(destination):
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {"revision": REVISION, "files": {}}
    for folder in ("", "/encoder", "/tokenizer", "/thx01"):
        with urllib.request.urlopen(f"{BASE}/api/models/doofz/THX-01/tree/{REVISION}{folder}", timeout=60) as response:
            entries = json.load(response)
        for entry in entries:
            path = entry["path"]
            if entry["type"] != "file":
                continue
            if not folder and path not in {"config.json", "rl_agent_config.json", "model.safetensors", "LICENSE", "NOTICE"}:
                continue
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".part")
            with urllib.request.urlopen(f"{BASE}/doofz/THX-01/resolve/{REVISION}/{path}", timeout=120) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            digest = hashlib.file_digest(temporary.open("rb"), "sha256").hexdigest()
            expected = WEIGHT_SHA256 if path == "model.safetensors" else entry.get("lfs", {}).get("oid")
            if expected and digest != expected:
                raise ValueError(f"Digest mismatch: {path}")
            temporary.replace(target)
            manifest["files"][path] = {"sha256": digest, "bytes": target.stat().st_size}
            print(f"prepared {path}: {target.stat().st_size} bytes", flush=True)
    (destination / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]).resolve())
