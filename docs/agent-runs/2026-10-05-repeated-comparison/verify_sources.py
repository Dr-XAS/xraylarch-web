"""Verify every staged tracked file against the transported pinned git archives."""
import hashlib
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parent
result = {}
for arm in ("native", "app"):
    archive = root / f"drxas-repeated-{arm}-20261005.tar.gz"
    source = root / arm
    members, mismatches = set(), []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not (member.isfile() or member.issym()):
                continue
            members.add(member.name)
            target = source / member.name
            if member.issym():
                if not target.is_symlink() or str(target.readlink()) != member.linkname:
                    mismatches.append(member.name)
            elif not target.is_file() or hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(tar.extractfile(member).read()).digest():
                mismatches.append(member.name)
    extras = sorted(str(path.relative_to(source)) for path in source.rglob("*")
                    if path.is_file() and str(path.relative_to(source)) not in members
                    and "__pycache__" not in path.parts and path.suffix != ".pyc")
    result[arm] = {"archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                   "tracked_files_checked": len(members), "tracked_mismatches": mismatches,
                   "untracked_non_bytecode_files": extras}
result["app_generated_version"] = {"path": "app/larch/_version.py", "reason": "build metadata excluded from git archive",
    "sha256": hashlib.sha256((root / "app/larch/_version.py").read_bytes()).hexdigest(),
    "version": "2026.3.1.post321+g7f82058f3", "generation": "setuptools_scm post-release from exact pin git describe"}
(root / "source-verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({arm: {"checked": result[arm]["tracked_files_checked"], "mismatches": len(result[arm]["tracked_mismatches"]),
                        "extra_files": len(result[arm]["untracked_non_bytecode_files"])} for arm in ("native", "app")}))
raise SystemExit(int(any(result[arm]["tracked_mismatches"] for arm in ("native", "app"))))
