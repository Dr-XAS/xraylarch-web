"""Copy only named, bounded evidence files, excluding runtime stores and raw logs."""
import argparse
from pathlib import Path
import shutil

ARM_FILES = ("answer.md", "configuration.json", "events.jsonl", "final-science.json",
             "initial-science.json", "native-state.json", "provider.json", "run.json", "run.partial.json", "science.json")
RUNTIME_FILES = ("arm-meter.jsonl", "initial-summary.json", "measurement-hashes.json", "run.json", "transcript.jsonl", "report.txt")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root
    export = root / "export"
    export.mkdir(exist_ok=True)
    def copy(path):
        if path.is_file():
            target = export / path.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    for filename in ("schedule.json", "recovery.json", "preflight.json"):
        copy(root / filename)
    for repeat in range(1, 4):
        for n in range(1, 6):
            unit = root / "runs" / f"repeat-{repeat}" / f"T{n}"
            copy(unit / "manifest.json")
            for arm in ("native", "app"):
                for filename in ARM_FILES:
                    copy(unit / f"{arm}-T{n}" / filename)
            for filename in RUNTIME_FILES:
                copy(unit / f"app-T{n}-runtime" / filename)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
