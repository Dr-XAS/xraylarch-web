"""Execute the preregistered 30 attempts without retries or answer-dependent choices."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

NATIVE = "19a0dfc90ff1a843f1b35c60a2cc3f1c574689ff"
APP = "7f82058f312d2e7f48df64a0f38dfdcfc0c7cbe7"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    (root / "runs").mkdir(exist_ok=False)
    schedule = [{"repeat": repeat, "task": f"T{task}",
                 "arms": ["native", "app"] if (repeat + task) % 2 == 0 else ["app", "native"]}
                for repeat in range(1, 4) for task in range(1, 6)]
    manifest = {"scheduled_attempts": 30, "schedule": schedule,
                "protocol_sha256": hashlib.sha256((root / "protocol.md").read_bytes()).hexdigest(),
                "native_revision": NATIVE, "app_revision": APP, "launch_results": []}
    path = root / "schedule.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    for unit in schedule:
        out = root / "runs" / f"repeat-{unit['repeat']}" / unit["task"]
        command = [str(args.python), str(root / "run_pair.py"), "--python", str(args.python),
                   "--app-python", str(args.python), "--native-root", str(root / "native"),
                   "--app-root", str(root / "app"), "--fixture", str(root / "fixture/fixture.json"),
                   "--out", str(out), "--model", "gpt56luna", "--tasks", unit["task"],
                   "--native-revision", NATIVE, "--app-revision", APP, "--arms", *unit["arms"]]
        result = subprocess.run(command, check=False)
        manifest["launch_results"].append({**unit, "returncode": result.returncode})
        path.write_text(json.dumps(manifest, indent=2) + "\n")
        if result.returncode:
            # Infrastructure errors interrupt the schedule; recovery retains attempts.
            break
    return int(any(row["returncode"] for row in manifest["launch_results"]))

if __name__ == "__main__":
    sys.exit(main())
