from concurrent.futures import ThreadPoolExecutor
import threading

import numpy as np
import pytest

from xraylarch_web.contracts import RecipeDraft
from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload
import xraylarch_web.workspace as workspace_module
from xraylarch_web.workspace import WorkspaceStore


def _mapped_workspace(data_root, synthetic_xmu_bytes):
    store = WorkspaceStore(data_root)
    workspace = store.create()
    upload_id = store.save_upload(
        workspace.workspace_id,
        parse_upload(synthetic_xmu_bytes, "synthetic.xmu"),
    )
    source = store.confirm_mapping(
        workspace.workspace_id,
        upload_id,
        "energy",
        "mu",
    )
    return store, workspace.workspace_id, source


def test_apply_creates_an_immutable_processed_revision(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)

    applied = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    snapshot = store.load(workspace_id)

    assert applied.parent_revision_id is None
    assert applied.source_revision_id == source.revision_id
    assert snapshot.active_revision_id == applied.revision_id
    assert [revision.revision_id for revision in snapshot.revisions] == [
        source.revision_id,
        applied.revision_id,
    ]
    restored = store.load(workspace_id)
    assert restored.active_result is not None
    assert all(np.isfinite(trace.y).all() for trace in restored.active_result.plots)


def test_restore_creates_new_revision_without_deleting_history(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    first = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(rbkg=1.2),
    )
    second = store.restore_revision(
        workspace_id,
        first.revision_id,
        expected_parent_revision=first.revision_id,
    )
    snapshot = store.load(workspace_id)

    assert second.revision_id > first.revision_id
    assert second.parent_revision_id == first.revision_id
    assert second.restored_from_revision_id == first.revision_id
    assert snapshot.active_revision_id == second.revision_id
    assert [revision.revision_id for revision in snapshot.revisions] == [
        source.revision_id,
        first.revision_id,
        second.revision_id,
    ]


def test_restore_snapshot_rehydrates_the_restored_source_not_latest_mapping(
    data_root, xas_arrays
):
    energy, mu = xas_arrays
    first_bytes = b"# energy mu\n" + b"\n".join(
        f"{x:.8f} {y:.12f}".encode() for x, y in zip(energy, mu, strict=True)
    )
    second_bytes = b"# energy mu\n" + b"\n".join(
        f"{x:.8f} {y + 0.25:.12f}".encode()
        for x, y in zip(energy, mu, strict=True)
    )
    store = WorkspaceStore(data_root)
    workspace_id = store.create().workspace_id

    first_upload = store.save_upload(
        workspace_id, parse_upload(first_bytes, "source-a.xmu")
    )
    first_source = store.confirm_mapping(
        workspace_id, first_upload, "column_0001", "column_0002"
    )
    first_applied = store.apply_revision(
        workspace_id,
        first_source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )

    second_upload = store.save_upload(
        workspace_id, parse_upload(second_bytes, "source-b.xmu")
    )
    second_source = store.confirm_mapping(
        workspace_id, second_upload, "column_0001", "column_0002"
    )
    second_applied = store.apply_revision(
        workspace_id,
        second_source.revision_id,
        expected_parent_revision=first_applied.revision_id,
        recipe=RecipeDraft(),
    )
    restored = store.restore_revision(
        workspace_id,
        first_applied.revision_id,
        expected_parent_revision=second_applied.revision_id,
    )

    snapshot = store.load(workspace_id)
    preview = store.preview(workspace_id, snapshot.active_source.source_revision_id, RecipeDraft())

    assert restored.source_revision_id == first_source.revision_id
    assert snapshot.active_source is not None
    assert snapshot.active_source.source_revision_id == first_source.revision_id
    assert snapshot.active_source.upload_id == first_upload
    assert snapshot.active_source.display_name == "source-a.xmu"
    assert snapshot.active_source.row_count == len(energy)
    assert snapshot.active_source.energy_column_id == "column_0001"
    assert snapshot.active_source.signal_column_id == "column_0002"
    assert [column.column_id for column in snapshot.active_source.columns] == [
        "column_0001",
        "column_0002",
    ]
    assert snapshot.draft_source is not None
    assert snapshot.draft_source.source_revision_id == second_source.revision_id
    assert np.asarray(preview.plots[0].y) == pytest.approx(mu)


def test_stale_apply_preserves_current_revision(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    current = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )

    with pytest.raises(WebInputError) as error:
        store.apply_revision(
            workspace_id,
            source.revision_id,
            expected_parent_revision=None,
            recipe=RecipeDraft(rbkg=1.5),
        )

    assert error.value.code == "stale_revision"
    assert store.load(workspace_id).active_revision_id == current.revision_id


def test_concurrent_apply_rejects_the_loser_as_stale(
    data_root, synthetic_xmu_bytes, monkeypatch
):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    original_run_processing = workspace_module.run_processing
    first_processing_started = threading.Event()
    second_processing_started = threading.Event()
    release_processing = threading.Event()
    started_count = 0
    started_lock = threading.Lock()

    def paused_run_processing(*args, **kwargs):
        nonlocal started_count
        with started_lock:
            started_count += 1
            if started_count == 1:
                first_processing_started.set()
            else:
                second_processing_started.set()
        assert release_processing.wait(timeout=5)
        return original_run_processing(*args, **kwargs)

    monkeypatch.setattr(workspace_module, "run_processing", paused_run_processing)

    def apply():
        return store.apply_revision(
            workspace_id,
            source.revision_id,
            expected_parent_revision=None,
            recipe=RecipeDraft(),
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(apply)
        assert first_processing_started.wait(timeout=5)
        second = executor.submit(apply)
        second_processing_started.wait(timeout=0.25)
        assert not second_processing_started.is_set()
        release_processing.set()

        outcomes = []
        for future in (first, second):
            try:
                outcomes.append(future.result(timeout=10))
            except WebInputError as error:
                outcomes.append(error)

    successful = [outcome for outcome in outcomes if not isinstance(outcome, WebInputError)]
    failures = [outcome for outcome in outcomes if isinstance(outcome, WebInputError)]
    snapshot = store.load(workspace_id)

    assert len(successful) == 1
    assert [failure.code for failure in failures] == ["stale_revision"]
    assert snapshot.active_revision_id == successful[0].revision_id
    assert [revision.revision_id for revision in snapshot.revisions] == [
        source.revision_id,
        successful[0].revision_id,
    ]


def test_failed_processing_after_apply_preserves_active_state(
    data_root, synthetic_xmu_bytes
):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    active = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    before = store.load(workspace_id)

    with pytest.raises(WebInputError) as error:
        store.apply_revision(
            workspace_id,
            source.revision_id,
            expected_parent_revision=active.revision_id,
            recipe=RecipeDraft(ft_window="invalid-window"),
        )

    after = store.load(workspace_id)
    assert error.value.code == "processing_failed"
    assert after.active_revision_id == before.active_revision_id
    assert after.active_result == before.active_result
    assert after.revisions == before.revisions


def test_storage_rejects_parent_directory_as_a_file_name(data_root):
    store = WorkspaceStore(data_root)
    workspace = store.create()

    with pytest.raises(WebInputError) as error:
        store.storage.path(workspace.workspace_id, "..")

    assert error.value.code == "storage_invalid_name"


def test_storage_never_serializes_object_arrays(data_root):
    store = WorkspaceStore(data_root)
    workspace = store.create()

    with pytest.raises(WebInputError) as error:
        store.storage.write_arrays(
            workspace.workspace_id,
            "unsafe.npz",
            {"unsafe": np.asarray([object()], dtype=object)},
        )

    assert error.value.code == "storage_invalid_array"


def test_legacy_workspace_is_migrated_and_persisted_on_load(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    applied = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    metadata["uploads"][next(iter(metadata["uploads"]))]["columns"] = [
        {key: value for key, value in column.items() if key != "column_id"}
        for column in metadata["uploads"][next(iter(metadata["uploads"]))]["columns"]
    ]
    metadata["revisions"][1].pop("effective")
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    snapshot = store.load(workspace_id)
    migrated = store.storage.read_json(workspace_id, "workspace.json")
    migrated_revision = migrated["revisions"][1]

    assert snapshot.active_revision_id == applied.revision_id
    assert migrated["schema_version"] == 2
    assert [column["column_id"] for column in migrated["uploads"][next(iter(migrated["uploads"]))]["columns"]] == [
        "column_0001",
        "column_0002",
    ]
    assert migrated_revision["effective"] == migrated_revision["result"]["effective"]
    assert migrated_revision["effective"] == applied.effective.model_dump(mode="json")


def test_legacy_workspace_rejects_conflicting_effective_provenance(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata["schema_version"] = 1
    metadata["revisions"][1]["result"]["effective"]["rbkg"] = 99.0
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    with pytest.raises(WebInputError) as error:
        store.load(workspace_id)

    assert error.value.code == "workspace_schema_invalid"


def test_legacy_workspace_migration_is_idempotent(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    store.load(workspace_id)
    first = store.storage.path(workspace_id, "workspace.json").read_bytes()
    store.load(workspace_id)
    second = store.storage.path(workspace_id, "workspace.json").read_bytes()

    assert first == second


def test_future_workspace_schema_is_rejected(data_root):
    store = WorkspaceStore(data_root)
    workspace = store.create()
    metadata = store.storage.read_json(workspace.workspace_id, "workspace.json")
    metadata["schema_version"] = 999
    store.storage.write_json(workspace.workspace_id, "workspace.json", metadata)

    with pytest.raises(WebInputError) as error:
        store.load(workspace.workspace_id)

    assert error.value.code == "workspace_schema_unsupported"


def test_legacy_fourier_bounds_preserve_xftf_provenance(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    applied = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    legacy_effective = {
        "e0": 7112.0,
        "edge_step": 1.0,
        "rbkg": 1.0,
        "kmin": 2.0,
        "kmax": 10.0,
        "kweight": 2,
        "autobk_dk": 1.0,
        "autobk_window": "hanning",
        "ft_dk": 1.0,
        "ft_dk2": 1.0,
        "ft_window": "kaiser",
        "nfft": 2048,
        "kstep": 0.05,
        "rmax_out": 10.0,
    }
    metadata["revisions"][1]["effective"] = legacy_effective.copy()
    metadata["revisions"][1]["result"]["effective"] = legacy_effective.copy()
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    store.load(workspace_id)
    migrated = store.storage.read_json(workspace_id, "workspace.json")["revisions"][1]["effective"]

    assert migrated["xftf_kmin"] == 2.0
    assert migrated["xftf_kmax"] == 10.0
    assert migrated["autobk_kmin"] == 0.0
    assert applied.revision_id == 2


def test_restoring_legacy_revision_keeps_provenance_consistent(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    applied = store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    legacy_effective = metadata["revisions"][1]["effective"]
    for key in ("xftf_kmin", "xftf_kmax", "xftf_dk", "xftf_dk2", "xftf_window"):
        legacy_effective[key.replace("xftf_", "") if key != "xftf_window" else "ft_window"] = legacy_effective.pop(key)
    metadata["revisions"][1]["result"]["effective"] = legacy_effective.copy()
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    store.load(workspace_id)
    restored = store.restore_revision(
        workspace_id,
        applied.revision_id,
        expected_parent_revision=applied.revision_id,
    )
    snapshot = store.load(workspace_id)

    assert restored.revision_id == 3
    assert snapshot.active_revision_id == restored.revision_id
    assert snapshot.active_result is not None


def test_legacy_workspace_column_id_collision_preserves_source_array(data_root):
    store = WorkspaceStore(data_root)
    workspace_id = store.create().workspace_id
    data = b"energy,mu,column_0002\n" + b"7000,1,10\n7001,2,20\n"
    upload_id = store.save_upload(workspace_id, parse_upload(data, "collision.csv"))
    source = store.confirm_mapping(workspace_id, upload_id, "energy", "mu")
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    upload = metadata["uploads"][upload_id]
    upload["columns"] = [
        {key: value for key, value in column.items() if key != "column_id"}
        for column in upload["columns"]
    ]
    metadata["revisions"][0]["energy_column"] = "energy"
    metadata["revisions"][0]["signal_column"] = "mu"
    arrays_name = upload["arrays_name"]
    store.storage.write_arrays(
        workspace_id,
        arrays_name,
        {"energy": np.array([7000.0, 7001.0]), "mu": np.array([1.0, 2.0]), "column_0002": np.array([10.0, 20.0])},
    )
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    store.load(workspace_id)
    migrated = store.storage.read_json(workspace_id, "workspace.json")
    assert migrated["revisions"][0]["signal_column"] == "column_0002"
    parsed = store._parsed_upload(workspace_id, migrated, upload_id)
    assert parsed.arrays["column_0002"].tolist() == [1.0, 2.0]
    assert source.revision_id == 1


def test_legacy_workspace_label_matching_generated_id_preserves_selection(data_root):
    store = WorkspaceStore(data_root)
    workspace_id = store.create().workspace_id
    data = b"energy,mu,column_0002\n7000,1,10\n7001,2,20\n"
    upload_id = store.save_upload(workspace_id, parse_upload(data, "label.csv"))
    source = store.confirm_mapping(workspace_id, upload_id, "energy", "column_0002")
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    upload = metadata["uploads"][upload_id]
    upload["columns"] = [
        {key: value for key, value in column.items() if key != "column_id"}
        for column in upload["columns"]
    ]
    metadata["revisions"][0]["energy_column"] = "energy"
    metadata["revisions"][0]["signal_column"] = "column_0002"
    store.storage.write_arrays(
        workspace_id,
        upload["arrays_name"],
        {"energy": np.array([7000.0, 7001.0]), "mu": np.array([1.0, 2.0]), "column_0002": np.array([10.0, 20.0])},
    )
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    store.load(workspace_id)
    migrated = store.storage.read_json(workspace_id, "workspace.json")
    assert migrated["revisions"][0]["signal_column"] == "column_0003"
    assert source.revision_id == 1


def test_legacy_workspace_mixed_upload_generations_use_mapping_upload_marker(data_root):
    store = WorkspaceStore(data_root)
    workspace_id = store.create().workspace_id
    data = b"energy,mu,column_0002\n7000,1,10\n7001,2,20\n"
    upload_id = store.save_upload(workspace_id, parse_upload(data, "legacy.csv"))
    source = store.confirm_mapping(workspace_id, upload_id, "energy", "column_0002")
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    upload = metadata["uploads"][upload_id]
    upload["columns"] = [
        {key: value for key, value in column.items() if key != "column_id"}
        for column in upload["columns"]
    ]
    upload.pop("_legacy_column_keys", None)
    upload.pop("_legacy_ids_backfilled", None)
    metadata["revisions"][0]["energy_column"] = "energy"
    metadata["revisions"][0]["signal_column"] = "column_0002"
    later_id = "ABCDEFGHIJKLMNOP"
    metadata["uploads"][later_id] = {
        **upload,
        "display_name": "current.csv",
        "columns": [column.model_dump(mode="json") for column in parse_upload(data, "current.csv").columns],
        "arrays_name": "later.npz",
    }
    store.storage.write_arrays(
        workspace_id,
        upload["arrays_name"],
        {"energy": np.array([7000.0, 7001.0]), "mu": np.array([1.0, 2.0]), "column_0002": np.array([10.0, 20.0])},
    )
    store.storage.write_arrays(
        workspace_id,
        "later.npz",
        {"column_0001": np.array([7000.0, 7001.0]), "column_0002": np.array([1.0, 2.0]), "column_0003": np.array([10.0, 20.0])},
    )
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    store.load(workspace_id)
    migrated = store.storage.read_json(workspace_id, "workspace.json")
    assert migrated["revisions"][0]["signal_column"] == "column_0003"
    assert source.revision_id == 1


def test_legacy_workspace_rejects_missing_result_artifact(data_root, synthetic_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, synthetic_xmu_bytes)
    store.apply_revision(
        workspace_id,
        source.revision_id,
        expected_parent_revision=None,
        recipe=RecipeDraft(),
    )
    metadata = store.storage.read_json(workspace_id, "workspace.json")
    metadata.pop("schema_version")
    result_name = metadata["revisions"][1]["result"]["arrays_name"]
    store.storage.path(workspace_id, result_name).unlink()
    store.storage.write_json(workspace_id, "workspace.json", metadata)

    with pytest.raises(WebInputError) as error:
        store.load(workspace_id)

    assert error.value.code == "workspace_schema_invalid"
