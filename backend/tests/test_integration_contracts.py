from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from xraylarch_web.integration_contracts import (
    ArtifactSourceIdentity,
    AuthoritativeSpectrum,
    CoreProcessingRecipe,
    DraftStatus,
    DraftSummary,
    DraftSummaryList,
    IntegrationContractBundle,
    LaunchEnvelope,
    NumericalTolerances,
    OneTimeLaunchHandle,
    ParityStatus,
    PortableProvenance,
    SealedImportEnvelope,
    canonical_json_bytes,
    canonical_sha256,
    contract_schema_fingerprint,
    normalized_contract_schema,
)


SHA = "a" * 64
NOW = datetime(2026, 9, 10, 12, tzinfo=UTC)
HANDLE = "AbCdEfGhIjKlMnOpQrStUv"


def source_payload() -> dict:
    return {
        "conversation_id": "conversation-1",
        "turn_id": "turn-1",
        "artifact_id": "artifact-1",
        "artifact_version": 2,
        "artifact_sha256": SHA,
        "branch_id": "branch-1",
        "branch_revision": 3,
    }


def recipe_payload() -> dict:
    return {
        "recipe_version": 1,
        "larch_version": "2026.1.0",
        "normalization": {
            "e0": 8980.0,
            "edge_step": 1.2,
            "pre1": -150.0,
            "pre2": -30.0,
            "norm1": 150.0,
            "norm2": 700.0,
            "nnorm": 2,
            "nvict": 1,
            "flatten": True,
            "energy_shift": 0.0,
        },
        "autobk": {
            "rbkg": 1.0,
            "kmin": 0.0,
            "kmax": 15.0,
            "kweight": 2.0,
            "dk": 1.0,
            "window": "hanning",
            "nclamp": 5,
            "nknots": 12,
            "clamp_lo": 0.0,
            "clamp_hi": 1.0,
        },
        "forward_ft": {
            "kmin": 3.0,
            "kmax": 14.0,
            "kweight": 2.0,
            "dk": 1.0,
            "dk2": 0.75,
            "window": "kaiser",
            "rmax_out": 12.0,
            "nfft": 4096,
            "kstep": 0.025,
            "with_phase": True,
        },
        "reverse_ft": {
            "rmin": 1.0,
            "rmax": 3.0,
            "dr": 0.5,
            "dr2": 0.25,
            "window": "hanning",
            "qmax_out": 25.0,
            "nfft": 4096,
            "kstep": 0.025,
            "with_phase": True,
        },
    }


def launch_payload() -> dict:
    spectrum = AuthoritativeSpectrum(
        energy=(8800.0, 8980.0, 10000.0), mu=(0.2, 1.0, 1.2)
    )
    recipe = CoreProcessingRecipe.model_validate(recipe_payload())
    return {
        "schema_version": 1,
        "source": source_payload(),
        "provenance": {
            "source_filename": "cu.xmu",
            "parse_recipe_id": "recipe-1",
            "column_signature_sha256": "c" * 64,
            "operation_ids": ["normalize", "autobk"],
        },
        "spectrum": spectrum.model_dump(mode="json"),
        "recipe": recipe.model_dump(mode="json"),
        "spectrum_sha256": canonical_sha256(spectrum),
        "recipe_sha256": canonical_sha256(recipe),
        "created_at": NOW.isoformat(),
        "expires_at": (NOW + timedelta(minutes=5)).isoformat(),
    }


def sealed_payload() -> dict:
    launch = LaunchEnvelope.model_validate_json(json.dumps(launch_payload()))
    return {
        "schema_version": 1,
        "draft_id": "draft-1",
        "source": launch.source.model_dump(mode="json"),
        "spectrum": launch.spectrum.model_dump(mode="json"),
        "recipe": launch.recipe.model_dump(mode="json"),
        "spectrum_sha256": launch.spectrum_sha256,
        "recipe_sha256": launch.recipe_sha256,
        "sealed_at": NOW.isoformat(),
        "parity_status": "not_checked",
    }


def test_valid_launch_json_roundtrip_is_immutable_and_uses_tuples():
    launch = LaunchEnvelope.model_validate_json(json.dumps(launch_payload()))

    assert launch == LaunchEnvelope.model_validate_json(launch.model_dump_json())
    assert launch.spectrum.energy == (8800.0, 8980.0, 10000.0)
    assert launch.provenance.operation_ids == ("normalize", "autobk")
    with pytest.raises(ValidationError):
        launch.spectrum.mu = (1.0, 2.0, 3.0)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("schema_version",), 2),
        (("schema_version",), "1"),
        (("source", "artifact_version"), 0),
        (("source", "branch_revision"), -1),
        (("source", "artifact_sha256"), "A" * 64),
        (("source", "artifact_sha256"), "a" * 63),
        (("provenance", "column_signature_sha256"), "not-a-digest"),
        (("created_at",), "2026-09-10T12:00:00"),
    ],
)
def test_launch_rejects_versions_digests_and_naive_dates(path, value):
    payload = launch_payload()
    target = payload
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        LaunchEnvelope.model_validate_json(json.dumps(payload))


def test_all_contract_models_are_strict_and_forbid_extra_fields():
    with pytest.raises(ValidationError):
        ArtifactSourceIdentity.model_validate(
            source_payload() | {"storage_key": "private/key"}
        )
    with pytest.raises(ValidationError):
        ArtifactSourceIdentity.model_validate(source_payload() | {"artifact_version": "2"})
    with pytest.raises(ValidationError):
        LaunchEnvelope.model_validate_json(
            json.dumps(launch_payload() | {"owner_id": "user-1"})
        )


@pytest.mark.parametrize(
    "filename",
    [
        "../cu.xmu",
        "/tmp/cu.xmu",
        "folder/cu.xmu",
        "folder\\cu.xmu",
        ".",
        "",
        "bad\nname.xmu",
        "bad\x00name.xmu",
        "bad\x85name.xmu",
        "C:cu.xmu",
        "CON",
        "con.xmu",
        "PRN.dat",
        "AUX",
        "NUL.txt",
        "COM1.xdi",
        "com9",
        "LPT1.xmu",
        "lpt9.dat",
    ],
)
def test_portable_provenance_rejects_unsafe_or_nonportable_filenames(filename):
    with pytest.raises(ValidationError):
        PortableProvenance(source_filename=filename)


def test_portable_provenance_accepts_safe_basename_and_bounds_operation_ids():
    provenance = PortableProvenance(
        source_filename="Cu sample.xmu",
        operation_ids=tuple(str(i) for i in range(128)),
    )
    assert len(provenance.operation_ids) == 128
    with pytest.raises(ValidationError):
        PortableProvenance(
            source_filename="cu.xmu",
            operation_ids=tuple(str(i) for i in range(129)),
        )


@pytest.mark.parametrize(
    ("energy", "mu"),
    [
        ([1.0], [2.0]),
        ([1.0, 2.0], [2.0]),
        ([1.0, 1.0], [2.0, 3.0]),
        ([2.0, 1.0], [2.0, 3.0]),
        ([1.0, float("nan")], [2.0, 3.0]),
        ([1.0, 2.0], [2.0, float("inf")]),
    ],
)
def test_authoritative_spectrum_invariants(energy, mu):
    with pytest.raises(ValidationError):
        AuthoritativeSpectrum(energy=energy, mu=mu)


def test_authoritative_spectrum_requires_at_least_three_points():
    with pytest.raises(ValidationError):
        AuthoritativeSpectrum(energy=(1.0, 2.0), mu=(3.0, 4.0))


def test_authoritative_spectrum_enforces_runtime_maximum_points():
    maximum = tuple(float(i) for i in range(100_000))
    assert len(AuthoritativeSpectrum(energy=maximum, mu=maximum).energy) == 100_000
    oversized = maximum + (100_000.0,)
    with pytest.raises(ValidationError):
        AuthoritativeSpectrum(energy=oversized, mu=oversized)


@pytest.mark.parametrize(
    "window", ["hanning", "parzen", "welch", "gaussian", "sine", "kaiser"]
)
def test_recipe_supports_all_windows(window):
    payload = recipe_payload()
    payload["forward_ft"]["window"] = window
    assert CoreProcessingRecipe.model_validate(payload).forward_ft.window == window


@pytest.mark.parametrize(
    ("section", "changes"),
    [
        ("normalization", {"pre1": -10.0, "pre2": -20.0}),
        ("normalization", {"norm1": 100.0, "norm2": 50.0}),
        ("autobk", {"kmin": 10.0, "kmax": 5.0}),
        ("autobk", {"rbkg": 0.0}),
        ("autobk", {"kweight": 4.1}),
        ("forward_ft", {"kmin": 10.0, "kmax": 5.0}),
        ("forward_ft", {"window": "blackman"}),
        ("forward_ft", {"nfft": 127}),
        ("forward_ft", {"nfft": 1000}),
        ("forward_ft", {"nfft": 131072}),
        ("reverse_ft", {"rmin": 4.0, "rmax": 3.0}),
        ("reverse_ft", {"window": "unknown"}),
    ],
)
def test_recipe_rejects_out_of_bounds_unordered_and_invalid_fft(section, changes):
    payload = recipe_payload()
    payload[section].update(changes)
    with pytest.raises(ValidationError):
        CoreProcessingRecipe.model_validate(payload)


def test_recipe_preserves_replay_affecting_non_default_values():
    recipe = CoreProcessingRecipe.model_validate(recipe_payload())
    assert recipe.normalization.nvict == 1
    assert recipe.autobk.nknots == 12
    assert recipe.forward_ft.dk2 == 0.75
    assert recipe.forward_ft.rmax_out == 12.0
    assert recipe.forward_ft.nfft == 4096
    assert recipe.forward_ft.kstep == 0.025
    assert recipe.forward_ft.with_phase is True
    assert recipe.reverse_ft.dr2 == 0.25
    assert recipe.reverse_ft.qmax_out == 25.0
    assert recipe.reverse_ft.nfft == 4096
    assert recipe.reverse_ft.kstep == 0.025
    assert recipe.reverse_ft.with_phase is True


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("normalization", "nvict", -1),
        ("normalization", "nvict", 11),
        ("normalization", "nvict", True),
        ("autobk", "nknots", -1),
        ("autobk", "nknots", 10001),
        ("autobk", "nknots", 1.5),
        ("forward_ft", "dk2", 21.0),
        ("forward_ft", "rmax_out", 0.0),
        ("forward_ft", "with_phase", 1),
        ("reverse_ft", "dr2", 21.0),
        ("reverse_ft", "qmax_out", 101.0),
        ("reverse_ft", "nfft", 1000),
        ("reverse_ft", "nfft", 131072),
        ("reverse_ft", "kstep", 0.0001),
        ("reverse_ft", "with_phase", "true"),
    ],
)
def test_replay_fields_enforce_strict_runtime_bounds(section, field, value):
    payload = recipe_payload()
    payload[section][field] = value
    with pytest.raises(ValidationError):
        CoreProcessingRecipe.model_validate(payload)


def test_recipe_rejects_nonfinite_and_requires_positive_gaussian_kaiser_widths():
    payload = recipe_payload()
    payload["autobk"]["dk"] = float("nan")
    with pytest.raises(ValidationError):
        CoreProcessingRecipe.model_validate(payload)

    payload = recipe_payload()
    payload["forward_ft"].update(window="kaiser", dk=0.0)
    with pytest.raises(ValidationError):
        CoreProcessingRecipe.model_validate(payload)


def test_recipe_has_no_digest_fields():
    recipe = recipe_payload() | {"recipe_sha256": SHA}
    with pytest.raises(ValidationError):
        CoreProcessingRecipe.model_validate(recipe)


def test_canonical_digest_uses_utf8_compact_sorted_json_without_nan():
    spectrum = AuthoritativeSpectrum(
        energy=(1.0, 2.0, 3.0), mu=(3.0, 4.0, 5.0)
    )
    expected = b'{"energy":[1.0,2.0,3.0],"mu":[3.0,4.0,5.0]}'

    assert canonical_json_bytes(spectrum) == expected
    assert canonical_sha256(spectrum) == hashlib.sha256(expected).hexdigest()
    with pytest.raises(ValueError):
        canonical_json_bytes(
            AuthoritativeSpectrum.model_construct(
                energy=(1.0, 2.0, 3.0), mu=(3.0, 4.0, float("nan"))
            )
        )


@pytest.mark.parametrize("envelope_factory", [launch_payload, sealed_payload])
@pytest.mark.parametrize("field", ["spectrum_sha256", "recipe_sha256"])
def test_envelope_rejects_declared_digest_mismatch(envelope_factory, field):
    payload = envelope_factory()
    payload[field] = "f" * 64
    with pytest.raises(ValidationError, match=field):
        model = LaunchEnvelope if envelope_factory is launch_payload else SealedImportEnvelope
        model.model_validate_json(json.dumps(payload))


def test_digest_validation_detects_payload_tampering():
    payload = launch_payload()
    payload["spectrum"]["mu"][0] = 9.0
    with pytest.raises(ValidationError, match="spectrum_sha256"):
        LaunchEnvelope.model_validate_json(json.dumps(payload))

    payload = launch_payload()
    payload["recipe"]["normalization"]["edge_step"] = 2.0
    with pytest.raises(ValidationError, match="recipe_sha256"):
        LaunchEnvelope.model_validate_json(json.dumps(payload))


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"e0": 8800.0}, "e0"),
        ({"e0": 10000.0}, "e0"),
        ({"pre1": -181.0}, "pre1"),
        ({"pre1": None, "pre2": -181.0}, "pre2"),
        ({"norm1": 1021.0, "norm2": 1022.0}, "norm1"),
        ({"norm2": 1021.0}, "norm2"),
    ],
)
def test_launch_rejects_normalization_outside_shifted_energy_axis(changes, message):
    payload = launch_payload()
    payload["recipe"]["normalization"].update(changes)
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["recipe_sha256"] = canonical_sha256(recipe)
    with pytest.raises(ValidationError, match=message):
        LaunchEnvelope.model_validate_json(json.dumps(payload))


@pytest.mark.parametrize("e0", [8980.0, 9000.0])
def test_e0_may_equal_second_or_penultimate_shifted_energy_sample(e0):
    payload = launch_payload()
    payload["spectrum"] = {
        "energy": [8800.0, 8980.0, 9000.0, 10000.0],
        "mu": [0.2, 1.0, 1.1, 1.2],
    }
    payload["recipe"]["normalization"].update(
        pre1=None, pre2=None, norm1=None, norm2=None
    )
    payload["recipe"]["normalization"]["e0"] = e0
    spectrum = AuthoritativeSpectrum.model_validate_json(
        json.dumps(payload["spectrum"])
    )
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["spectrum_sha256"] = canonical_sha256(spectrum)
    payload["recipe_sha256"] = canonical_sha256(recipe)
    assert LaunchEnvelope.model_validate_json(json.dumps(payload)).recipe.normalization.e0 == e0


def test_e0_rejects_values_outside_inner_shifted_energy_samples():
    for e0 in (8979.0, 9001.0):
        payload = launch_payload()
        payload["spectrum"] = {
            "energy": [8800.0, 8980.0, 9000.0, 10000.0],
            "mu": [0.2, 1.0, 1.1, 1.2],
        }
        payload["recipe"]["normalization"].update(
            e0=e0, pre1=None, pre2=None, norm1=None, norm2=None
        )
        spectrum = AuthoritativeSpectrum.model_validate_json(
            json.dumps(payload["spectrum"])
        )
        recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
        payload["spectrum_sha256"] = canonical_sha256(spectrum)
        payload["recipe_sha256"] = canonical_sha256(recipe)
        with pytest.raises(ValidationError, match="second and penultimate shifted"):
            LaunchEnvelope.model_validate_json(json.dumps(payload))


def test_forward_fft_capacity_rejects_insufficient_nfft_and_runtime_padding():
    for changes in ({"nfft": 128}, {"kstep": 0.001}):
        payload = launch_payload()
        payload["recipe"]["forward_ft"].update(changes)
        recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
        payload["recipe_sha256"] = canonical_sha256(recipe)
        with pytest.raises(ValidationError, match="FFT capacity"):
            LaunchEnvelope.model_validate_json(json.dumps(payload))


def test_forward_fft_capacity_accepts_complete_grid_that_exactly_fits_nfft():
    payload = launch_payload()
    payload["spectrum"] = {
        "energy": [1000.0, 1050.0, 1100.0, 50000.0],
        "mu": [0.1, 0.2, 1.0, 1.2],
    }
    payload["recipe"]["normalization"].update(
        e0=1100.0, pre1=-100.0, pre2=-50.0, norm1=100.0, norm2=1000.0
    )
    payload["recipe"]["autobk"]["kmax"] = 81.88
    payload["recipe"]["forward_ft"].update(
        nfft=2048, kstep=0.04, kmax=81.88, dk2=0.0
    )
    spectrum = AuthoritativeSpectrum.model_validate_json(json.dumps(payload["spectrum"]))
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["spectrum_sha256"] = canonical_sha256(spectrum)
    payload["recipe_sha256"] = canonical_sha256(recipe)

    assert LaunchEnvelope.model_validate_json(json.dumps(payload)).recipe.forward_ft.nfft == 2048


def test_forward_fft_capacity_rejects_taper_beyond_selected_nfft():
    payload = launch_payload()
    payload["spectrum"] = {
        "energy": [1000.0, 1050.0, 1100.0, 50000.0],
        "mu": [0.1, 0.2, 1.0, 1.2],
    }
    payload["recipe"]["normalization"].update(
        e0=1100.0, pre1=-100.0, pre2=-50.0, norm1=100.0, norm2=1000.0
    )
    payload["recipe"]["autobk"]["kmax"] = 81.88
    payload["recipe"]["forward_ft"].update(
        nfft=2048, kstep=0.04, kmax=81.88, dk2=1.0
    )
    spectrum = AuthoritativeSpectrum.model_validate_json(json.dumps(payload["spectrum"]))
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["spectrum_sha256"] = canonical_sha256(spectrum)
    payload["recipe_sha256"] = canonical_sha256(recipe)

    with pytest.raises(ValidationError, match="nfft"):
        LaunchEnvelope.model_validate_json(json.dumps(payload))


def test_fft_capacity_uses_requested_autobk_range_for_long_spectrum():
    payload = launch_payload()
    payload["spectrum"] = {
        "energy": [7000.0, 7050.0, 7100.0, 7200.0, 20000.0],
        "mu": [0.1, 0.2, 1.0, 1.1, 1.2],
    }
    payload["recipe"]["normalization"].update(
        e0=7100.0, pre1=-100.0, pre2=-50.0, norm1=100.0, norm2=1000.0
    )
    payload["recipe"]["autobk"]["kmax"] = 15.0
    payload["recipe"]["forward_ft"]["kmax"] = 15.0
    spectrum = AuthoritativeSpectrum.model_validate_json(json.dumps(payload["spectrum"]))
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["spectrum_sha256"] = canonical_sha256(spectrum)
    payload["recipe_sha256"] = canonical_sha256(recipe)
    assert LaunchEnvelope.model_validate_json(json.dumps(payload)).recipe.autobk.kmax == 15.0


def test_forward_kmax_cannot_exceed_autobk_range():
    payload = launch_payload()
    payload["recipe"]["autobk"]["kmax"] = 14.0
    payload["recipe"]["forward_ft"]["kmax"] = 15.0
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["recipe_sha256"] = canonical_sha256(recipe)
    with pytest.raises(ValidationError, match="forward_ft.kmax"):
        LaunchEnvelope.model_validate_json(json.dumps(payload))


def test_launch_applies_energy_shift_before_normalization_range_checks():
    payload = launch_payload()
    payload["recipe"]["normalization"].update(
        energy_shift=10.0, e0=8990.0, pre1=-180.0, norm2=1010.0
    )
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["recipe_sha256"] = canonical_sha256(recipe)
    launch = LaunchEnvelope.model_validate_json(json.dumps(payload))
    assert launch.recipe.normalization.e0 == 8990.0


@pytest.mark.parametrize("section", ["autobk", "forward_ft"])
def test_envelopes_reject_kmax_beyond_reachable_shifted_energy(section):
    payload = launch_payload()
    payload["recipe"][section]["kmax"] = 17.0
    if section == "forward_ft":
        payload["recipe"]["autobk"]["kmax"] = 17.0
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["recipe_sha256"] = canonical_sha256(recipe)
    expected_section = "autobk" if section == "forward_ft" else section
    with pytest.raises(ValidationError, match=rf"{expected_section}\.kmax.*reachable"):
        LaunchEnvelope.model_validate_json(json.dumps(payload))

    sealed = sealed_payload()
    sealed["recipe"][section]["kmax"] = 17.0
    if section == "forward_ft":
        sealed["recipe"]["autobk"]["kmax"] = 17.0
    recipe = CoreProcessingRecipe.model_validate(sealed["recipe"])
    sealed["recipe_sha256"] = canonical_sha256(recipe)
    with pytest.raises(ValidationError, match=rf"{expected_section}\.kmax.*reachable"):
        SealedImportEnvelope.model_validate_json(json.dumps(sealed))


def test_sealed_import_rejects_normalization_outside_shifted_energy_axis():
    payload = sealed_payload()
    payload["recipe"]["normalization"]["norm2"] = 1021.0
    recipe = CoreProcessingRecipe.model_validate(payload["recipe"])
    payload["recipe_sha256"] = canonical_sha256(recipe)
    with pytest.raises(ValidationError, match="normalization.norm2"):
        SealedImportEnvelope.model_validate_json(json.dumps(payload))


def test_lifecycle_enums_and_tolerances_are_fixed_local_policy():
    assert {status.value for status in DraftStatus} == {
        "active", "importing", "sealed", "discarded", "expired", "failed"
    }
    assert {status.value for status in ParityStatus} == {
        "matched", "mismatched", "not_checked"
    }
    assert NumericalTolerances() == NumericalTolerances(
        scalar_absolute=1e-8,
        scalar_relative=1e-6,
        array_absolute=1e-7,
        array_relative=1e-5,
        minimum_match_fraction=0.999,
    )
    for field, value in (
        ("scalar_absolute", 2e-8),
        ("scalar_relative", 2e-6),
        ("array_absolute", 2e-7),
        ("array_relative", 2e-5),
        ("minimum_match_fraction", 0.998),
    ):
        with pytest.raises(ValidationError):
            NumericalTolerances.model_validate({field: value})


def test_draft_summaries_enforce_lifecycle_and_ordering():
    first = DraftSummary(
        draft_id="draft-1",
        status=DraftStatus.ACTIVE,
        created_at=NOW,
        updated_at=NOW,
        expires_at=NOW + timedelta(days=7),
        operation_count=0,
    )
    second = DraftSummary(
        draft_id="draft-2",
        status=DraftStatus.SEALED,
        created_at=NOW,
        updated_at=NOW + timedelta(seconds=1),
        expires_at=NOW + timedelta(days=7),
        operation_count=1,
        latest_operation_id="normalize",
    )
    assert DraftSummaryList(drafts=(first, second)).drafts == (first, second)
    with pytest.raises(ValidationError, match="ordered"):
        DraftSummaryList(drafts=(second, first))

    expired = DraftSummary(
        draft_id="draft-expired",
        status=DraftStatus.EXPIRED,
        created_at=NOW,
        updated_at=NOW + timedelta(days=6),
        expires_at=NOW + timedelta(days=7),
        operation_count=0,
    )
    assert expired.status is DraftStatus.EXPIRED

    with pytest.raises(ValidationError, match="latest_operation_id"):
        DraftSummary(
            draft_id="draft-missing-operation",
            status=DraftStatus.ACTIVE,
            created_at=NOW,
            updated_at=NOW,
            expires_at=NOW + timedelta(days=7),
            operation_count=1,
        )

    for updated_at, expires_at in (
        (NOW - timedelta(seconds=1), NOW + timedelta(days=7)),
        (NOW + timedelta(days=7), NOW + timedelta(days=7)),
        (NOW, NOW + timedelta(days=7, seconds=1)),
    ):
        with pytest.raises(ValidationError):
            DraftSummary(
                draft_id="draft-3",
                status=DraftStatus.ACTIVE,
                created_at=NOW,
                updated_at=updated_at,
                expires_at=expires_at,
                operation_count=0,
            )


@pytest.mark.parametrize("model", [OneTimeLaunchHandle, LaunchEnvelope])
def test_launch_lifetimes_are_positive_and_at_most_five_minutes(model):
    if model is OneTimeLaunchHandle:
        base = {
            "schema_version": 1,
            "launch_handle": HANDLE,
            "created_at": NOW.isoformat(),
        }
    else:
        base = launch_payload()

    valid = base | {"expires_at": (NOW + timedelta(seconds=300)).isoformat()}
    model.model_validate_json(json.dumps(valid))
    for expires_at in (NOW, NOW + timedelta(seconds=301)):
        with pytest.raises(ValidationError, match="300 seconds|later"):
            model.model_validate_json(
                json.dumps(base | {"expires_at": expires_at.isoformat()})
            )


@pytest.mark.parametrize(
    "handle",
    ["a" * 21, "a" * 129, "opaque.value.with.dots", "contains+plus", "with/slash", "has=padding"],
)
def test_one_time_handle_requires_bounded_base64url(handle):
    with pytest.raises(ValidationError):
        OneTimeLaunchHandle(
            schema_version=1,
            launch_handle=handle,
            created_at=NOW,
            expires_at=NOW + timedelta(minutes=5),
        )


def test_sealed_import_only_accepts_not_checked_and_no_tolerance_override():
    payload = sealed_payload()
    sealed = SealedImportEnvelope.model_validate_json(json.dumps(payload))
    assert sealed == SealedImportEnvelope.model_validate_json(sealed.model_dump_json())
    for invalid in ("matched", "mismatched"):
        with pytest.raises(ValidationError):
            SealedImportEnvelope.model_validate_json(
                json.dumps(payload | {"parity_status": invalid})
            )
    with pytest.raises(ValidationError):
        SealedImportEnvelope.model_validate_json(
            json.dumps(payload | {"tolerances": {"scalar_absolute": 1.0}})
        )


def test_root_bundle_emits_all_contracts_in_json_schema():
    definitions = IntegrationContractBundle.model_json_schema()["$defs"]
    for name in (
        "LaunchEnvelope",
        "OneTimeLaunchHandle",
        "DraftSummaryList",
        "SealedImportEnvelope",
        "NumericalTolerances",
    ):
        assert name in definitions

    handle_schema = definitions["OneTimeLaunchHandle"]["properties"]["launch_handle"]
    assert handle_schema == {
        "maxLength": 128,
        "minLength": 22,
        "pattern": "^[A-Za-z0-9_-]+$",
        "title": "Launch Handle",
        "type": "string",
    }
    tolerance_properties = definitions["NumericalTolerances"]["properties"]
    assert tolerance_properties["scalar_absolute"]["const"] == 1e-8
    assert tolerance_properties["scalar_relative"]["const"] == 1e-6
    assert tolerance_properties["array_absolute"]["const"] == 1e-7
    assert tolerance_properties["array_relative"]["const"] == 1e-5
    assert tolerance_properties["minimum_match_fraction"]["const"] == 0.999


def test_vendored_schema_matches_local_contract_and_fingerprint():
    schema_path = (
        Path(__file__).parents[1]
        / "xraylarch_web"
        / "contracts"
        / "xraylarch-integration-v1.schema.json"
    )
    vendored = json.loads(schema_path.read_text(encoding="utf-8"))
    expected_fingerprint = vendored.pop("x-schema-sha256")
    for metadata_key in ("$schema", "$id", "x-schema-version"):
        vendored.pop(metadata_key, None)

    assert vendored == normalized_contract_schema()
    assert expected_fingerprint == contract_schema_fingerprint()
