"""Bundled AMCSD search and bounded, isolated native FEFF8L calculations."""
from __future__ import annotations

import copy
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Literal
from types import SimpleNamespace

if os.name == "nt":
    import msvcrt
else:
    import fcntl

import larixite
import psutil
from fastapi import APIRouter, Query
from larixite.amcsd import AMCSD
from larixite.cif_cluster import CIF_Cluster, cif2feffinp
from larch.xafs.feffrunner import find_exe
from pydantic import Field, model_validator
from xraydb import atomic_number, xray_edge

from .artemis import PathInput, StrictModel, inspect_path
from .errors import WebInputError

_DATABASE = Path(larixite.__file__).parent / "amcsd_cif1.db"
_SOURCE = "Bundled curated AMCSD database (larixite amcsd_cif1.db; not the full online archive)"
_DB_LOCK = threading.RLock()
_CONVERSION_LOCK = threading.RLock()
_DATABASE_INSTANCE = None
_MODULES = ("rdinp", "pot", "xsph", "pathfinder", "genfmt", "ff2x")
_TIMEOUT = 180
_MAX_DISK_BYTES = 80_000_000
_JOB_ID = re.compile(r"^[0-9a-f]{32}$")
_SELECT = """SELECT c.id, m.name AS mineral, c.formula, s.hm_notation AS space_group,
 p.year, p.journalname AS journal, c.pub_title AS title,
 (SELECT group_concat(a.name, ', ') FROM authors a JOIN publication_authors pa
  ON pa.author_id=a.id WHERE pa.publication_id=p.id) AS authors
 FROM cif c JOIN minerals m ON m.id=c.mineral_id
 JOIN spacegroups s ON s.id=c.spacegroup_id JOIN publications p ON p.id=c.publication_id"""


def _fail(message, field="structure", code="invalid_artemis_structure"):
    raise WebInputError(code, message, fields=(field,),
                        recovery="Choose a supported ordered structure, absorber site, and bounded FEFF settings, then retry.")


@contextmanager
def _connection():
    try:
        connection = sqlite3.connect(f"file:{_DATABASE}?mode=ro", uri=True)
    except sqlite3.Error:
        _fail("The bundled AMCSD database is unavailable. Restore the larixite package data before searching.", "database")
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def _element(value):
    value = value.strip().capitalize()
    try:
        if not re.fullmatch(r"[A-Z][a-z]?", value) or atomic_number(value) is None:
            raise ValueError("invalid element")
    except (ValueError, KeyError):
        _fail("Select a valid chemical element.", "absorber")
    return value


def _summary(row):
    result = dict(row)
    if result["mineral"] in (None, "", "<missing>"):
        result["mineral"] = result["formula"] or "Unnamed structure"
    for key in ("formula", "space_group", "authors", "journal", "title"):
        if result[key] in (None, "<missing>"):
            result[key] = ""
    return result


def search_structures(query: str = "", element: str = "", limit: int = 25):
    query = query.strip()
    literal = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    compact = re.sub(r"\s+", "", query)
    compact_literal = re.sub(r"\s+", "", literal)
    clauses, args = [], []
    if query:
        if query.isdigit():
            if not 0 < int(query) <= 99_999_999:
                return dict(query=query, source=_SOURCE, results=[], count=0, limited=False)
            clauses.append("c.id=?")
            args.append(int(query))
        else:
            # Literal substring matching; no client regex or SQL wildcard grammar.
            pattern = "%" + literal + "%"
            clauses.append("(m.name LIKE ? ESCAPE '\\' OR replace(c.formula, ' ', '') LIKE ? ESCAPE '\\' OR c.pub_title LIKE ? ESCAPE '\\')")
            args += [pattern, "%" + compact_literal + "%", pattern]
    if element.strip():
        clauses.append("EXISTS (SELECT 1 FROM cif_elements ce WHERE ce.cif_id=c.id AND ce.element=?)")
        args.append(_element(element))
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with _connection() as connection:
        ranking = """ ORDER BY CASE WHEN lower(m.name)=lower(?) THEN 0
          WHEN lower(replace(c.formula, ' ', ''))=lower(?) THEN 1 WHEN m.name LIKE ? ESCAPE '\\' THEN 2
          WHEN m.name LIKE ? ESCAPE '\\' THEN 3 WHEN replace(c.formula, ' ', '') LIKE ? ESCAPE '\\' THEN 4
          ELSE 5 END, m.name, c.id LIMIT ?"""
        rows = connection.execute(_SELECT + where + ranking, args + [query, compact, literal + "%", "%" + literal + "%", "%" + compact_literal + "%", limit + 1]).fetchall()
    return dict(query=query, source=_SOURCE, results=[_summary(row) for row in rows[:limit]],
                count=min(limit, len(rows)), limited=len(rows) > limit)


def _native_cif(ident):
    global _DATABASE_INSTANCE
    with _DB_LOCK:
        if _DATABASE_INSTANCE is None:
            # get_amcsd() defaults to downloading the full archive and copying a
            # database into the user's home. Explicitly use the bundled snapshot.
            _DATABASE_INSTANCE = AMCSD(str(_DATABASE), read_only=True)
        cif = _DATABASE_INSTANCE.get_cif(ident)
        if cif is None:
            _fail("This AMCSD entry is not available in the bundled database.")
        return cif


def _supported_structure(cif):
    cluster = CIF_Cluster(ciftext=cif.ciftext)
    # Pymatgen may normalize slightly excessive occupancies, and larixite fills
    # vacancies on singleton sites. Check original occupancy AND parsed disorder.
    occupancy = cif.atoms_occupancy
    raw_ordered = occupancy is None or all(abs(float(value) - 1) <= 1e-8 for value in occupancy)
    ordered = bool(cluster.struct.is_ordered and raw_ordered)
    return cluster, ordered


def _describe_structure(output, cif):
    output.update(sites=[], elements=[], ordered=False, supported=False, warnings=[], cell={})
    try:
        cluster, ordered = _supported_structure(cif)
        output["ordered"] = ordered
        output["elements"] = sorted(cluster.atom_sites)
        output["cell"] = dict(zip(("a", "b", "c", "alpha", "beta", "gamma"),
                                 [float(value) for value in cluster.struct.lattice.parameters]))
        for index, (site, multiplicity, wyckoff) in enumerate(cluster.unique_sites, 1):
            for species, occupancy in site.species.items():
                x, y, z = (float(value) for value in site.frac_coords)
                output["sites"].append(dict(index=index, element=species.symbol, species=site.species_string,
                                            occupancy=float(occupancy), multiplicity=multiplicity,
                                            wyckoff=str(wyckoff), x=x, y=y, z=z))
        if not ordered:
            output["warnings"].append("Partial occupancies, vacancies, and mixed-species sites are not supported. Select an ordered structure; no random substitution is performed.")
        elif len(cluster.struct) > 500 or len(output["elements"]) > 10 or cluster.struct.volume <= 0.1:
            output["warnings"].append("This structure exceeds the atom or element limits for a bounded FEFF8L calculation.")
        else:
            output["supported"] = True
    except Exception:
        output["warnings"].append("The stored CIF could not be interpreted as a supported periodic crystal structure.")
    return output


@lru_cache(maxsize=64)
def structure_details(ident: int):
    if not 0 < ident <= 99_999_999:
        _fail("Use a valid numeric AMCSD structure identifier.")
    with _connection() as connection:
        row = connection.execute(_SELECT + " WHERE c.id=?", (ident,)).fetchone()
    if row is None:
        _fail("This AMCSD entry is not available in the bundled database.")
    cif = _native_cif(ident)
    return _describe_structure(_summary(row) | dict(source=_SOURCE, cif=cif.ciftext), cif)


def snapshot_details(details):
    """Revalidate imported attachment science from CIF text, without the database."""
    from pymatgen.io.cif import CifParser

    output = copy.deepcopy(details)
    try:
        occupancy = []
        for block in CifParser.from_str(details["cif"]).as_dict().values():
            entries = block.get("_atom_site_occupancy", [])
            if isinstance(entries, str):
                entries = [entries]
            occupancy.extend(float(re.sub(r"\([0-9]+\)$", "", value)) for value in entries)
        # Prefix ensures larixite cannot interpret any imported text as a path.
        cif = SimpleNamespace(ciftext="# Attached CIF snapshot\n" + details["cif"],
                              atoms_occupancy=occupancy or None)
        return _describe_structure(output, cif)
    except Exception:
        output.update(supported=False, ordered=False, sites=[], elements=[], cell={},
                      warnings=["The attached CIF could not be interpreted as a supported periodic structure."])
        return output


class FeffJobRequest(StrictModel):
    amcsd_id: int | None = Field(default=None, gt=0, le=99_999_999)
    project_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{16,128}$")
    attachment_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$")
    version: int | None = Field(default=None, ge=0)
    absorber: str = Field(min_length=1, max_length=2)
    edge: Literal["K", "L1", "L2", "L3"] = "K"
    site_index: int = Field(ge=1, le=500)
    cluster_radius: float = Field(default=5, ge=3, le=6)
    path_radius: float = Field(default=4, ge=2, le=6)
    max_legs: int = Field(default=4, ge=2, le=4)
    max_paths: int = Field(default=60, ge=1, le=100)

    @model_validator(mode="after")
    def validate_settings(self):
        if self.path_radius > self.cluster_radius:
            raise ValueError("Path radius must not exceed the atomic cluster radius.")
        if any(value is not None for value in (self.project_id, self.attachment_id, self.version)):
            if any(value is None for value in (self.project_id, self.attachment_id, self.version)) or self.amcsd_id is not None:
                raise ValueError("Use project_id, attachment_id, and version together, without amcsd_id.")
        elif self.amcsd_id is None:
            raise ValueError("Choose an AMCSD record or an attached project CIF.")
        return self


def _prepare_input(request: FeffJobRequest, details: dict):
    with _CONVERSION_LOCK:
        # Keep the converter used by Larch's CIF browser. cifid must not be
        # passed because cif_extra_titles() opens the default network database.
        cluster = CIF_Cluster(ciftext=details["cif"], absorber=request.absorber)
        site = cluster.unique_sites[request.site_index - 1][0]
        density_count = len(cluster.struct) * (4 * math.pi / 3) * request.cluster_radius ** 3 / cluster.struct.volume
        extents = [math.ceil(request.cluster_radius * length) for length in cluster.struct.lattice.reciprocal_lattice_crystallographic.abc]
        candidate_count = len(cluster.struct) * math.prod(2 * extent + 3 for extent in extents)
        if density_count > 400 or candidate_count > 100_000:
            _fail("This cell and radius require too many periodic atoms. Reduce the radius or choose a conventional, physically sized cell.", "cluster_radius")
        # Count the actual sphere before native conversion allocates a supercell.
        neighbors = cluster.struct.get_sites_in_sphere(site.coords, request.cluster_radius)
        if len(neighbors) > 400:
            _fail("The selected radius includes more than 400 atoms. Reduce the cluster radius.", "cluster_radius")
        text = cif2feffinp(details["cif"], request.absorber, edge=request.edge,
                          absorber_site=request.site_index, cluster_size=request.cluster_radius,
                          version8=True, with_h=False, rng_seed=0, extra_titles=[f"AMCSD structure {details['id']}"])
    text = re.sub(r"(?m)^RPATH\s+.*$", f"RPATH     {request.path_radius:.3f}", text)
    text = re.sub(r"(?m)^NLEG\s+.*$", f"NLEG      {request.max_legs}", text)
    return text


def _executables():
    executables = {}
    for module in _MODULES:
        executable = find_exe(f"feff8l_{module}")
        if executable is None:
            _fail(f"The bundled FEFF8L {module} executable is unavailable.", "runtime", "feff_unavailable")
        executables[module] = Path(executable).resolve()
    return executables


def _lock_slot(stream):
    if os.name == "nt":
        # msvcrt locks a byte range; closing this handle releases its lock.
        stream.seek(0, 2)
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


class FeffJobs:
    """Small disk-backed job store; every subprocess gets its own cwd."""
    def __init__(self, root: Path, store=None):
        self.store = store
        self.root = Path(root) / "artemis-feff"
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.lock = threading.RLock()
        self.running: set[str] = set()
        self._prune()

    def _directory(self, ident):
        if not _JOB_ID.fullmatch(ident):
            _fail("The FEFF job identifier is invalid.", "job")
        directory = self.root / ident
        if directory.is_symlink():
            _fail("The FEFF job directory is invalid.", "job")
        if directory.is_dir():
            os.chmod(directory, 0o700)
        return directory

    def _slot(self):
        # The shared data-root locks enforce the two-job limit across workers,
        # and the OS releases a crashed worker's slot automatically.
        for index in range(2):
            path = self.root / f".slot-{index}.lock"
            stream = path.open("a+b")
            os.chmod(path, 0o600)
            try:
                _lock_slot(stream)
                return stream
            except OSError:
                stream.close()
        _fail("Two FEFF calculations are already running. Wait for one to finish, then retry.", "job", "feff_busy")

    @staticmethod
    def _owner_alive(record):
        pid = record.get("owner_pid", -1)
        if pid <= 0 or time.time() - record["created"] > _TIMEOUT + 30:
            return False
        try:
            process = psutil.Process(pid)
            expected_start = record.get("owner_started")
            return process.is_running() and (expected_start is None or process.create_time() == expected_start)
        except (psutil.Error, ValueError):
            return False

    def _save(self, directory, record):
        path = directory / "status.json"
        temporary = directory / f".status.{uuid.uuid4().hex}.tmp"
        try:
            self._write_private_text(temporary, json.dumps(record, allow_nan=False))
            temporary.replace(path)
            os.chmod(path, 0o600)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _write_private_text(path, value):
        path.write_text(value, encoding="utf-8")
        os.chmod(path, 0o600)

    def _prune(self, exclude=()):
        excluded = set(exclude)
        directories = []
        for item in self.root.iterdir():
            try:
                if (item.name in excluded or not _JOB_ID.fullmatch(item.name)
                        or item.is_symlink() or not item.is_dir()):
                    continue
                directories.append((item.stat().st_mtime, item))
            except FileNotFoundError:
                continue
        directories.sort(key=lambda entry: entry[0])
        for index, (modified, directory) in enumerate(directories):
            created = modified
            try:
                record = json.loads((directory / "status.json").read_text())
                created = float(record["created"])
                if record["status"] == "running" and self._owner_alive(record):
                    continue
            except (FileNotFoundError, KeyError, TypeError, ValueError):
                pass
            if directory.name not in self.running and (time.time() - created > 86400 or index < len(directories) - 18):
                shutil.rmtree(directory, ignore_errors=True)

    def start(self, request: FeffJobRequest):
        source_provenance = {}
        if request.project_id is not None:
            from .artemis_attachments import attached_source
            if self.store is None:
                _fail("This FEFF service cannot read project attachments.", "project")
            attachment, revision = attached_source(self.store, request.project_id, request.attachment_id, request.version)
            details = snapshot_details(attachment["structure"])
            source_provenance = dict(project_id=request.project_id, attachment_id=attachment["id"],
                                     source_revision=revision, cif_sha256=attachment["sha256"])
        else:
            details = copy.deepcopy(structure_details(request.amcsd_id))
        if not details["supported"]:
            _fail(" ".join(details["warnings"]) or "This CIF structure is unsupported.")
        absorber = _element(request.absorber)
        if not any(site["index"] == request.site_index and site["element"] == absorber for site in details["sites"]):
            _fail("Explicitly select a crystallographic site belonging to the chosen absorber.", "site_index")
        if xray_edge(absorber, request.edge) is None:
            _fail("The selected absorption edge is unavailable for this element.", "edge")
        request = request.model_copy(update={"absorber": absorber})
        executables = _executables()
        slot = self._slot()
        ident = uuid.uuid4().hex
        directory = self._directory(ident)
        record = dict(id=ident, status="running", stage="preparing", message="Preparing the atomic cluster.",
                      created=time.time(), owner_pid=os.getpid(), owner_started=psutil.Process().create_time(),
                      elapsed_seconds=0, request=request.model_dump(), log="",
                      provenance=dict(cif=details["cif"], feff_input="", structure={key: value for key, value in details.items()
                                      if key not in ("cif", "sites", "cell", "warnings")},
                                      converter=f"larixite {larixite.__version__}", engine="FEFF8L",
                                      s02=1.0, with_h=False, source=details["source"], **source_provenance), paths=[], total_paths=0, truncated=False,
                      warnings=["Hydrogen atoms are omitted from the FEFF cluster (with_h=False)."] if "H" in details["elements"] else [])
        try:
            with self.lock:
                self._prune()
                directory.mkdir(mode=0o700)
                os.chmod(directory, 0o700)
                self.running.add(ident)
                self._save(directory, record)
            thread = threading.Thread(target=self._run, args=(directory, record, request, details, executables, slot), daemon=True)
            thread.start()
        except Exception:
            self.running.discard(ident)
            slot.close()
            raise
        return self.get(ident)

    def get(self, ident):
        directory = self._directory(ident)
        with self.lock:
            try:
                record = json.loads((directory / "status.json").read_text())
            except FileNotFoundError:
                _fail("This FEFF job is unavailable or expired (jobs are retained up to 24 hours).", "job")
            if time.time() - record["created"] > 86400:
                if directory.name not in self.running:
                    shutil.rmtree(directory, ignore_errors=True)
                _fail("This FEFF job expired after 24 hours. Start a new calculation.", "job")
            self._prune(exclude=(ident,))
            if record["status"] == "running" and not self._owner_alive(record):
                record.update(status="failed", message="The server restarted before this calculation finished. Start a new job.")
                self._save(directory, record)
        record["elapsed_seconds"] = round(time.time() - record["created"], 2) if record["status"] == "running" else record["elapsed_seconds"]
        log = directory / "feff.log"
        if log.exists():
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 20000))
                record["log"] = stream.read(20000).decode("utf-8", errors="replace")
        if record["status"] == "complete":
            try:
                record["paths"] = json.loads((directory / "paths.json").read_text())
            except FileNotFoundError:
                _fail("This FEFF job is unavailable or expired (jobs are retained up to 24 hours).", "job")
        return record

    def _run_module(self, executable, directory, log, deadline):
        # Fixed packaged executables only, no shell and no global os.chdir.
        options = {"umask": 0o077} if os.name != "nt" else {}
        process = subprocess.Popen([str(executable)], cwd=directory, stdout=log,
                                   stderr=subprocess.STDOUT, **options)
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"The FEFF calculation exceeded {_TIMEOUT} seconds.")
                try:
                    code = process.wait(timeout=min(0.5, remaining))
                    if sum(item.stat().st_size for item in directory.iterdir() if item.is_file()) > _MAX_DISK_BYTES:
                        raise RuntimeError("The FEFF calculation exceeded its 80 MB output limit. Reduce the radius or maximum path legs.")
                    if code != 0:
                        raise RuntimeError(f"{executable.name} exited with status {code}. Inspect the FEFF log.")
                    return
                except subprocess.TimeoutExpired:
                    size = sum(item.stat().st_size for item in directory.iterdir() if item.is_file())
                    if size > _MAX_DISK_BYTES:
                        raise RuntimeError("The FEFF calculation exceeded its 80 MB output limit. Reduce the radius or maximum path legs.")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    def _run(self, directory, record, request, details, executables, slot):
        start = time.monotonic()
        try:
            feff_input = _prepare_input(request, details)
            self._write_private_text(directory / "source.cif", details["cif"])
            self._write_private_text(directory / "feff.inp", feff_input)
            record["provenance"]["feff_input"] = feff_input
            with (directory / "feff.log").open("wb") as log:
                os.chmod(directory / "feff.log", 0o600)
                for module, executable in executables.items():
                    record.update(stage=module, message=f"Running FEFF8L {module}.")
                    with self.lock:
                        self._save(directory, record)
                    log.write(f"\n=== FEFF8L {module} ===\n".encode())
                    log.flush()
                    self._run_module(executable, directory, log, start + _TIMEOUT)
            generated = sorted(directory.glob("feff[0-9][0-9][0-9][0-9].dat"))
            if not generated:
                raise RuntimeError("FEFF completed without producing scattering paths. Increase the path radius or choose another structure.")
            paths = []
            for filename in generated[:request.max_paths]:
                inspected = inspect_path(PathInput(filename=filename.name, content=filename.read_text()))
                paths.append(dict(id=filename.stem, **inspected))
            self._write_private_text(directory / "paths.json", json.dumps(paths, allow_nan=False))
            if sum(item.stat().st_size for item in directory.iterdir() if item.is_file()) > _MAX_DISK_BYTES:
                raise RuntimeError("The FEFF result exceeded its 80 MB output limit. Reduce the path count or radius.")
            record.update(status="complete", stage="complete", message=f"Generated {len(generated)} FEFF paths; {len(paths)} available for selection.",
                          total_paths=len(generated), truncated=len(generated) > len(paths))
            if record["truncated"]:
                record["warnings"].append(f"Only the first {len(paths)} of {len(generated)} generated paths are listed. Increase the path limit or reduce the path radius to inspect a smaller calculation.")
            record["warnings"].append("FEFF path degeneracies are retained. Select up to 24 paths for fitting; the absorber site's crystallographic multiplicity is not an additional amplitude multiplier.")
        except Exception as exc:
            record.update(status="failed", stage="failed", message=str(exc)[:1000])
        finally:
            record["elapsed_seconds"] = round(time.monotonic() - start, 2)
            try:
                with self.lock:
                    self._save(directory, record)
            finally:
                self.running.discard(record["id"])
                slot.close()


def build_structures_router(store):
    router = APIRouter(tags=["Artemis structures"])
    jobs = FeffJobs(store.settings.data_root, store=store)

    @router.get("/structures")
    def search(q: str = Query(default="", max_length=120), element: str = Query(default="", max_length=2),
               limit: int = Query(default=25, ge=1, le=50)):
        return search_structures(q, element, limit)

    @router.get("/structures/{ident}")
    def details(ident: int):
        return structure_details(ident)

    @router.post("/feff/jobs", status_code=202)
    def start(request: FeffJobRequest):
        return jobs.start(request)

    @router.get("/feff/jobs/{ident}")
    def status(ident: str):
        return jobs.get(ident)

    from .artemis_attachments import build_attachments_router
    router.include_router(build_attachments_router(store))
    return router
