"""Persistent v2 integration wire-contract tests."""
from __future__ import annotations

import math
from pathlib import Path
import subprocess
import sys

import pytest
from pydantic import ValidationError

from xraylarch_web.config import Settings
from xraylarch_web.integration_contracts import (
    AthenaUploadedSource,
    ExistingDrXasSource,
    ExportReservation,
    ProjectBootstrapRequest,
    ProjectQuota,
    ProjectSummary,
    SelectedGroupExportRequest,
    SelectedGroupRef,
)


def valid_uploaded_source() -> dict:
    return {
        "kind": "athena_upload",
        "original_filename": "sample.xdi",
        "raw_sha256": "a" * 64,
        "parse_metadata": {"columns": ["energy", "mu"]},
    }


def valid_quota(**changes) -> dict:
    return {
        "max_projects": 4,
        "max_files": 8,
        "max_bytes": 1_000_000,
        "max_groups": 12,
        "max_exports": 6,
        "ttl_seconds": None,
        **changes,
    }


def test_uploaded_source_rejects_private_fields():
    with pytest.raises(ValidationError):
        AthenaUploadedSource.model_validate({
            **valid_uploaded_source(),
            "filesystem_path": "/private/data/sample.xdi",
        })


def test_v2_models_reject_extra_fields_and_wrong_contract_version():
    with pytest.raises(ValidationError):
        ProjectBootstrapRequest.model_validate({
            "contract_version": 2,
            "name": "Copper foil",
            "persistent": True,
            "unexpected": True,
        })
    with pytest.raises(ValidationError):
        ProjectBootstrapRequest.model_validate({
            "contract_version": 1,
            "name": "Copper foil",
            "persistent": True,
        })


def test_uploaded_source_requires_finite_metadata_arrays():
    with pytest.raises(ValidationError):
        AthenaUploadedSource.model_validate({
            **valid_uploaded_source(),
            "parse_metadata": {"values": [1.0, math.inf]},
        })


@pytest.mark.parametrize("name", ["", "x" * 121])
def test_project_name_is_bounded(name):
    with pytest.raises(ValidationError):
        ProjectBootstrapRequest(
            contract_version=2,
            name=name,
            persistent=True,
        )


def test_group_export_selection_is_unique_and_bounded():
    selection = SelectedGroupRef(group_id="group-1", group_version=1)
    with pytest.raises(ValidationError, match="unique"):
        SelectedGroupExportRequest(
            contract_version=2,
            project_id="project-1",
            project_version=1,
            selections=(selection, selection),
        )
    with pytest.raises(ValidationError):
        SelectedGroupExportRequest(
            contract_version=2,
            project_id="project-1",
            project_version=1,
            selections=(),
        )


def test_project_summary_distinguishes_persistent_and_expiring_projects():
    persistent = ProjectSummary(
        contract_version=2,
        project_id="project-1",
        name="Persistent",
        persistent=True,
        project_version=0,
        group_count=0,
        file_count=0,
        stored_bytes=0,
        expires_at=None,
    )
    assert persistent.expires_at is None
    with pytest.raises(ValidationError, match="expires_at"):
        ProjectSummary(
            contract_version=2,
            project_id="project-1",
            name="Guest",
            persistent=False,
            project_version=0,
            group_count=0,
            file_count=0,
            stored_bytes=0,
            expires_at=None,
        )


def test_project_quota_requires_positive_limits_and_account_persistence():
    assert ProjectQuota.model_validate(valid_quota()).ttl_seconds is None
    with pytest.raises(ValidationError):
        ProjectQuota.model_validate(valid_quota(max_groups=0))
    with pytest.raises(ValidationError):
        ProjectQuota.model_validate(valid_quota(ttl_seconds=0))


def test_existing_source_and_reservation_have_exact_discriminators():
    source = ExistingDrXasSource(
        kind="drxas",
        turn_id="turn-1",
        artifact_id="artifact-1",
        artifact_version=1,
        source_sha256="b" * 64,
    )
    assert source.kind == "drxas"
    reservation = ExportReservation(
        contract_version=2,
        reservation_id="reservation-1",
        project_id="project-1",
        project_version=1,
        selections=(SelectedGroupRef(group_id="group-1", group_version=1),),
        status="prepared",
    )
    assert reservation.status == "prepared"


def test_guest_quota_cannot_exceed_account_quota(monkeypatch):
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_MAX_PROJECTS", "2")
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_GUEST_MAX_PROJECTS", "3")
    with pytest.raises(ValueError, match="guest"):
        Settings.from_environment()


def test_v2_contract_generator_is_deterministic_in_a_fresh_checkout():
    root = Path(__file__).resolve().parents[2]
    generated = root / "frontend/lib/generated/integration-contracts.ts"
    before = generated.read_bytes()
    subprocess.run(
        [sys.executable, "scripts/generate-integration-contracts.py", "--check"],
        cwd=root,
        env={**__import__("os").environ, "PYTHONPATH": str(root / "backend")},
        check=True,
    )
    assert generated.read_bytes() == before
