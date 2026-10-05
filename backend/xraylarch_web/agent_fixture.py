"""Export the task suite's measurements for a separate native-tool runtime.

Only measured energy and mu arrays cross this boundary. The native runtime must
process them with its own Larch; app-derived arrays and answer keys are omitted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def fixture(project: dict, *, revision: str, structure: dict) -> dict:
    from .agent_suite import TASKS

    labels = {group["id"]: group["label"] for group in project["groups"]}
    spectra = []
    for group in project["groups"]:
        arrays = {key: group[key] for key in ("energy", "mu")}
        digest = hashlib.sha256(json.dumps(arrays, separators=(",", ":"),
                                          allow_nan=False).encode()).hexdigest()
        spectra.append({
            "label": group["label"], "filename": group["source"].get("filename"),
            "citation": group["source"].get("citation"), **arrays,
            "parameters": group["parameters"], "measurement_sha256": digest,
            "reference_label": labels.get(group.get("reference_id")),
            "marked": group["marked"],
        })
    return {
        "schema_version": 1,
        "tasks": {key: {"prompt": task.prompt} for key, task in TASKS.items()},
        "spectra": spectra,
        "structure": {"material_id": "eval_copper_11145", "cif_path": "copper.cif",
                      "amcsd_id": 11145,
                      "cif_sha256": hashlib.sha256(structure["cif"].encode()).hexdigest()},
        "provenance": {"xraylarch_web_revision": revision,
                       "measurement_source": "Athena bundled example command",
                       "processing": "Requested parameters only; native arm resolves automatic values independently.",
                       "reference_note": "Shared reference repeats 300 K data; links do not represent simultaneous measurements."},
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="new fixture directory")
    args = parser.parse_args(argv)
    from fastapi.testclient import TestClient
    from .artemis_structures import structure_details
    from .config import Settings
    from .main import create_app

    args.out.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[2]
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    with tempfile.TemporaryDirectory(prefix="agent-fixture-") as root:
        with TestClient(create_app(Settings(data_root=Path(root)))) as client:
            made = client.post("/api/athena/projects", json={"name": "fixture export"})
            made.raise_for_status()
            project = made.json()
            loaded = client.post(f"/api/athena/projects/{project['id']}/command",
                                 json={"version": project["version"], "action": "example",
                                       "group_ids": [], "options": {}})
            loaded.raise_for_status()
            project = loaded.json()
            if any(group.get("processing_error") for group in project["groups"]):
                raise RuntimeError("Example fixture failed to process")
            structure = structure_details(11145)
            payload = fixture(project, revision=revision, structure=structure)
    (args.out / "fixture.json").write_text(json.dumps(payload, ensure_ascii=False,
                                                    allow_nan=False, indent=2) + "\n")
    (args.out / "copper.cif").write_text(structure["cif"])
    guide = (repo / "AGENTS.md").read_text().split("# Driving this app without a browser", 1)[1]
    (args.out / "app-guide.md").write_text("# Driving this app without a browser" + guide)
    print(f"Exported {len(payload['spectra'])} measurements and {len(payload['tasks'])} prompts to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
