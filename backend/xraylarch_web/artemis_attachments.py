"""Project-owned CIF snapshots, including bounded JSON/PRJ exchange."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .errors import WebInputError

MAX_STRUCTURES = 20
MAX_STRUCTURE_BYTES = 4_000_000
PROJECT_FIELD = "artemis_structures"


def _fail(message, field="artemis_structures"):
    raise WebInputError("invalid_artemis_attachment", message, fields=(field,),
                        recovery="Review the attached CIFs or import into a new local project, then retry.")


class SnapshotModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class SiteSnapshot(SnapshotModel):
    index: int = Field(ge=1, le=500)
    element: str = Field(pattern=r"^[A-Z][a-z]?$")
    species: str = Field(max_length=500)
    multiplicity: int = Field(ge=1, le=10000)
    wyckoff: str = Field(max_length=40)
    x: float
    y: float
    z: float
    occupancy: float = Field(ge=0, le=10)


class StructureSnapshot(SnapshotModel):
    id: int = Field(gt=0, le=99_999_999)
    mineral: str = Field(max_length=5000)
    formula: str = Field(max_length=5000)
    space_group: str = Field(max_length=500)
    authors: str = Field(max_length=10000)
    year: int | None
    journal: str = Field(max_length=5000)
    title: str = Field(max_length=20000)
    source: str = Field(max_length=2000)
    cif: str = Field(min_length=40, max_length=500_000)
    elements: list[str] = Field(max_length=120)
    sites: list[SiteSnapshot] = Field(max_length=2000)
    cell: dict[str, float]
    ordered: bool
    supported: bool
    warnings: list[str] = Field(max_length=100)

    @model_validator(mode="after")
    def validate_snapshot(self):
        if not re.search(r"(?m)^\s*data_\S*", self.cif) or "\n" not in self.cif or "\x00" in self.cif:
            raise ValueError("An attachment must contain full CIF text, not a filesystem path.")
        if len(self.cif.encode("utf-8")) > 500_000:
            raise ValueError("Each attached CIF must be at most 500 KB.")
        if set(self.cell) - {"a", "b", "c", "alpha", "beta", "gamma"}:
            raise ValueError("Unknown crystallographic cell field.")
        if any(len(value) > 2000 for value in self.warnings):
            raise ValueError("A structure warning is too long.")
        if any(not re.fullmatch(r"[A-Z][a-z]?", value) for value in self.elements):
            raise ValueError("Invalid structure element symbol.")
        return self


class StructureAttachment(SnapshotModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    amcsd_id: int = Field(gt=0, le=99_999_999)
    attached_at: str = Field(max_length=60)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    structure: StructureSnapshot

    @model_validator(mode="after")
    def validate_identity(self):
        if self.amcsd_id != self.structure.id:
            raise ValueError("The AMCSD identifiers do not agree.")
        if hashlib.sha256(self.structure.cif.encode("utf-8")).hexdigest() != self.sha256:
            raise ValueError("The attached CIF does not match its SHA-256 checksum.")
        datetime.fromisoformat(self.attached_at.replace("Z", "+00:00"))
        return self


class AttachRequest(SnapshotModel):
    version: int = Field(ge=0)
    amcsd_id: int = Field(gt=0, le=99_999_999)


def validate_attachments(records):
    if not isinstance(records, list) or len(records) > MAX_STRUCTURES:
        _fail(f"A project can contain at most {MAX_STRUCTURES} attached CIF structures.")
    try:
        if len(json.dumps(records, allow_nan=False, ensure_ascii=False).encode("utf-8")) > MAX_STRUCTURE_BYTES:
            _fail("Attached CIF structures exceed the 4 MB project limit.")
        output = [StructureAttachment.model_validate(record).model_dump() for record in records]
    except (ValidationError, ValueError, TypeError, RecursionError) as exc:
        if isinstance(exc, WebInputError):
            raise
        _fail(f"Invalid attached CIF snapshot: {str(exc)[:300]}")
    if len({record["id"] for record in output}) != len(output) or len({record["amcsd_id"] for record in output}) != len(output):
        _fail("Attached CIF identifiers and AMCSD IDs must be unique within a project.")
    return output


def merge_attachments(current, imported):
    result = validate_attachments(current)
    incoming = validate_attachments(imported)
    by_amcsd = {record["amcsd_id"]: record for record in result}
    ids = {record["id"] for record in result}
    for record in incoming:
        previous = by_amcsd.get(record["amcsd_id"])
        if previous is not None:
            if previous["sha256"] != record["sha256"]:
                _fail(f"AMCSD {record['amcsd_id']} already has a different CIF snapshot in this project. Import the other snapshot into a new project.")
            continue
        if record["id"] in ids:
            record["id"] = uuid.uuid4().hex
        result.append(record)
        ids.add(record["id"])
        by_amcsd[record["amcsd_id"]] = record
    return validate_attachments(result)


def local_project(store, ident):
    project = store.load(ident)
    if project.get("integration") is True:
        _fail("Import the integration draft into a local project before attaching or reading CIF structures.", "project")
    return project


def attached_source(store, project_id, attachment_id, version):
    with store.storage.lock(project_id):
        project = local_project(store, project_id)
        store.check(project, version)
        for record in validate_attachments(project.get(PROJECT_FIELD, [])):
            if record["id"] == attachment_id:
                return record, project["version"]
    _fail("This attached CIF is no longer present in the selected project.", "attachment_id")


def attach_structure(store, ident, request: AttachRequest):
    from .artemis_structures import structure_details

    with store.storage.lock(ident):
        old = local_project(store, ident)
        store.check(old, request.version)
        records = validate_attachments(old.get(PROJECT_FIELD, []))
        if any(record["amcsd_id"] == request.amcsd_id for record in records):
            return old
        if len(records) >= MAX_STRUCTURES:
            _fail(f"A project can contain at most {MAX_STRUCTURES} attached CIF structures.")
        details = copy.deepcopy(structure_details(request.amcsd_id))
        record = dict(id=uuid.uuid4().hex, amcsd_id=request.amcsd_id,
                      attached_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      sha256=hashlib.sha256(details["cif"].encode("utf-8")).hexdigest(), structure=details)
        updated = copy.deepcopy(old)
        updated[PROJECT_FIELD] = validate_attachments([*records, record])
        return store.save(updated, old, f"Attached AMCSD {request.amcsd_id}: {details['mineral']}")


def build_attachments_router(store):
    router = APIRouter(tags=["Artemis project structures"])

    @router.get("/projects/{ident}/structures")
    def list_structures(ident: str):
        project = local_project(store, ident)
        return dict(project_id=ident, version=project["version"],
                    structures=validate_attachments(project.get(PROJECT_FIELD, [])))

    @router.post("/projects/{ident}/structures")
    def attach(ident: str, request: AttachRequest):
        return attach_structure(store, ident, request)

    return router
