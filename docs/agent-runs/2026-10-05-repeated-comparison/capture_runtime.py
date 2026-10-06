"""Record library and source identity without environment variables or credentials."""
import hashlib
from importlib import metadata
import json
from pathlib import Path
import sys
import larch
import numpy
import scipy

root = Path(__file__).resolve().parent
archives = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in root.glob("drxas-repeated-*.tar.gz")}
result = {"python": sys.version, "interpreter": sys.executable,
          "app_imported_larch": {"version": larch.__version__, "file": larch.__file__},
          "numpy": {"version": numpy.__version__, "file": numpy.__file__},
          "scipy": {"version": scipy.__version__, "file": scipy.__file__},
          "packages": {name: metadata.version(name) for name in ("openai", "openai-agents", "xraylarch", "larixite")},
          "source_archives_sha256": archives,
          "app_generated_version": "2026.3.1.post321+g7f82058f3",
          "version_provenance": "git describe --tags --long 7f82058f312d2e7f48df64a0f38dfdcfc0c7cbe7 => 2026.3.1-321-g7f82058f3; setuptools_scm post-release scheme writes larch/_version.py",
          "setup_failures": [{"path": str(path.relative_to(root)), "error_type": "ModuleNotFoundError", "missing_module": "larch._version", "model_started": False}
                             for path in sorted((root / "runs").glob("repeat-*/T*/app-T*-setup-failure"))]}
(root / "runtime-provenance.json").write_text(json.dumps(result, indent=2) + "\n")
