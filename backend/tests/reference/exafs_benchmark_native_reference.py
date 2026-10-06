"""Rebuild the EXAFS benchmark fixtures from the reference fits they were recorded from.

The fixtures under backend/tests/fixtures/exafs-benchmarks are copies: public
measured chi(k), the FEFF85L path files fitted against it, and the feffit result
each fit produced. test_artemis_benchmarks.py refits all of them through the web
request model and compares. Run this only to take a newer set of reference fits:

    python backend/tests/reference/exafs_benchmark_native_reference.py --lab PATH

It rewrites the fixture directory in place, so the test's sha256 checks and the
recorded commit move together with the data.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "backend/tests/fixtures/exafs-benchmarks"

# Each entry is the fixture name, the reference fit inside the lab's benchmarks
# directory, and a title a reader outside the project can place.
DATASETS = [
    ("coo", "coo/larch_feffit/coo_larch_feffit_reference.json", "CoO, Co K edge"),
    ("fe2o3", "fe2o3/larch_feffit/fe2o3_larch_feffit_reference.json", "alpha-Fe2O3, Fe K edge"),
    ("ge_foil", "ge_crystal/xasdb_ge_foil/larch_feffit/ge_foil_larch_feffit_reference.json",
     "Ge foil at 77 K, Ge K edge, scan 1"),
    ("ge_foil_scan2", "ge_crystal/xasdb_ge_foil_scan2/larch_feffit/ge_foil_larch_feffit_reference.json",
     "Ge foil at 77 K, Ge K edge, scan 2"),
    ("nio", "nio/larch_feffit/nio_larch_feffit_reference.json", "NiO, Ni K edge"),
    ("zno", "zno/larch_feffit/zno_larch_feffit_reference.json", "ZnO, Zn K edge"),
]
SCAN_KEYS = ("database", "facility", "facility_and_beamline", "beamline", "sample", "compound", "prep",
             "temperature", "measurement_method", "scan_mode", "monochromator", "detector",
             "detail_url", "doi", "license", "authors", "date")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(lab: Path):
    commit = subprocess.run(["git", "-C", str(lab), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    datasets = []
    for name, relative, title in DATASETS:
        reference = json.loads((lab / "benchmarks" / relative).read_text())
        protocol = reference["fit_protocol"]
        folder = OUT / name
        folder.mkdir()
        chi_target = folder / "chi.csv"
        shutil.copyfile(lab / reference["source"]["target_chi"], chi_target)

        wanted = {Path(entry["path"]).name: entry for model in reference["models"] for entry in model["paths"]}
        files = {}
        for filename, entry in sorted(wanted.items()):
            shutil.copyfile(lab / entry["path"], folder / filename)
            files[filename] = dict(file=f"{name}/{filename}", sha256=digest(folder / filename),
                                   shell=entry.get("shell"), feff_directory=Path(entry["path"]).parent.name)

        models = []
        for model in reference["models"]:
            # Shells are numbered by first appearance so the parameter names in
            # the fixture read as the app's own: delr1, ss1, delr2, ss2.
            shells, used = {}, []
            for entry in model["paths"]:
                shell = entry.get("shell") or Path(entry["path"]).stem
                used.append((Path(entry["path"]).name, shells.setdefault(shell, len(shells) + 1)))
            expected = dict(model["larch"])
            values = {}
            for key, block in model["parameters"].items():
                if key == "shells":
                    for shell, pair in block.items():
                        for field, label in (("deltar", "delr"), ("sigma2", "ss")):
                            values[f"{label}{shells[shell]}"] = {part: pair[field][part]
                                                                 for part in ("value", "stderr", "initial", "min", "max")}
                else:
                    values["enot" if key == "e0" else key] = {part: block[part]
                                                              for part in ("value", "stderr", "initial", "min", "max")}
            models.append(dict(name=model["name"], title=model["label"], paths=used,
                               expected=dict(success=expected["success"], nvarys=expected["nvarys"],
                                             ndata=expected["ndata"], nfev=expected["nfev"],
                                             n_independent=expected["n_independent"], rfactor=expected["rfactor"],
                                             chi_square=expected["chi_square"],
                                             reduced_chi_square=expected["reduced_chi_square"],
                                             aic=expected["aic"], bic=expected["bic"], parameters=values)))

        scan = reference["source"]["selected_scan"]
        datasets.append(dict(
            name=name, title=title, chi=dict(file=f"{name}/chi.csv", sha256=digest(chi_target)),
            measurement={key: scan[key] for key in SCAN_KEYS if key in scan},
            feff=dict(code=f"FEFF85L ({protocol['engine']} reference)",
                      directory=next(iter(files.values()))["feff_directory"]),
            transform=protocol["transform"], bounds=protocol["parameters"],
            epsilon_k=protocol["epsilon_k"], paths=files, models=models))

    manifest = dict(
        description=("Public EXAFS benchmark spectra, their FEFF85L scattering paths, and the Larch feffit "
                     "results the web fitting workflow is compared against."),
        source=dict(repository="unpublished benchmark checkout", commit=commit,
                    larch_version=json.loads((lab / "benchmarks" / DATASETS[0][1]).read_text())["larch_version"]),
        note=("epsilon_k is the root-mean-square of chi(k) over the fit window, the uncertainty scale the "
              "reference fits were given. Fitted values, uncertainties and the R factor do not depend on it; "
              "chi-square, reduced chi-square, AIC and BIC scale with 1/epsilon_k**2."),
        datasets=datasets)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    total = sum(item.stat().st_size for item in OUT.rglob("*") if item.is_file())
    print(f"wrote {OUT} ({total/1024:.0f} KiB, {len(list(OUT.rglob('*.dat')))} path files) from {commit}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lab", type=Path, required=True,
                        help="path to the reference-fit checkout holding benchmarks/")
    build(parser.parse_args().lab.resolve())
