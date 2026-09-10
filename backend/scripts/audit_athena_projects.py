"""Audit real projects in a temporary data store, retaining per-group failures.

Run from the repository root:
  PYTHONPATH=backend backend/.venv/bin/python backend/scripts/audit_athena_projects.py \
      --output docs/athena-project-corpus-results.json
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((root / "backend/tests/fixtures/athena-official-manifest.json").read_text())
    paths = sorted(set((root / "examples").rglob("*.prj")) | {root / item["file"] for item in manifest})
    rows = []
    for path in paths:
        data = path.read_bytes()
        row = {"file": str(path.relative_to(root)), "sha256": hashlib.sha256(data).hexdigest()}
        with TemporaryDirectory(prefix="athena-corpus-") as folder:
            store = AthenaStore(Settings(data_root=Path(folder)))
            try:
                project = store.create()
                restored = store.restore(project["id"], 0, data, path.name)
                row.update(groups=len(restored["groups"]), processed=sum(g["processing_error"] is None for g in restored["groups"]),
                           errors=[{"label": g["label"], "error": g["processing_error"]} for g in restored["groups"] if g["processing_error"]])
            except Exception as exc:
                row["import_error"] = str(exc)
        rows.append(row)
        print(row["file"], row.get("groups", 0), row.get("processed", 0), flush=True)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "Full import and processing using saved native recipes; original files are never edited. Parsed raw spectra remain available when a recipe fails. danger.prj deliberately contains executable code and must be rejected.",
        "summary": {"files": len(rows), "imported": sum("import_error" not in r for r in rows),
                    "groups": sum(r.get("groups", 0) for r in rows), "processed": sum(r.get("processed", 0) for r in rows),
                    "processing_errors": dict(Counter(e["error"] for r in rows for e in r.get("errors", [])))},
        "files": rows,
    }
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
