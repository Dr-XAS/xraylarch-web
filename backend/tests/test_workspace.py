import numpy as np
import pytest

from xraylarch_web.contracts import RecipeDraft
from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload
from xraylarch_web.workspace import WorkspaceStore


def _mapped_workspace(data_root, sample_xmu_bytes):
    store = WorkspaceStore(data_root)
    workspace = store.create()
    upload_id = store.save_upload(
        workspace.workspace_id,
        parse_upload(sample_xmu_bytes, "cu_rt01.xmu"),
    )
    source = store.confirm_mapping(
        workspace.workspace_id,
        upload_id,
        "energy",
        "mu",
    )
    return store, workspace.workspace_id, source


def test_apply_creates_an_immutable_processed_revision(data_root, sample_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, sample_xmu_bytes)

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


def test_restore_creates_new_revision_without_deleting_history(data_root, sample_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, sample_xmu_bytes)
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


def test_stale_apply_preserves_current_revision(data_root, sample_xmu_bytes):
    store, workspace_id, source = _mapped_workspace(data_root, sample_xmu_bytes)
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
