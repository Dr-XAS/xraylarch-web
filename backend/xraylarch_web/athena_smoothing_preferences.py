"""Athena's effective SG preferences, with session Apply and persistent Save."""
import copy
import threading
import uuid

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from .errors import WebInputError
from .storage import WorkspaceStorage


class SGValues(BaseModel):
    model_config = ConfigDict(extra='forbid')
    window: int = Field(default=31, strict=True, ge=0, le=39)
    # process.demeter_conf says default=4 but minint=9. Config::default
    # actually returns 9; use the executed effective default, not the literal.
    order: int = Field(default=9, strict=True, ge=9, le=39)


class SGPreferenceRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(strict=True, ge=0)
    session_id: str = Field(strict=True, min_length=1, max_length=128)
    values: SGValues
    save: StrictBool = False

    @model_validator(mode='after')
    def complete_values(self):
        if self.values.model_fields_set != {'window', 'order'}:
            raise ValueError('Supply both window and order when applying smoothing preferences.')
        return self


class SGSavedPreferences(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(default=0, strict=True, ge=0)
    values: SGValues = Field(default_factory=SGValues)


class SmoothingPreferences:
    """One runtime instance per service; a new instance represents restart."""
    def __init__(self, settings):
        self.storage = WorkspaceStorage(settings.data_root / 'preferences')
        self.ident = 'athena_preferences'
        try:
            self.storage.workspace_dir(self.ident, create=True)
        except FileExistsError:
            pass
        self.session_id = uuid.uuid4().hex
        self._lock = threading.RLock()
        self._version = 0
        self._disk_version = None
        self._saved = SGValues().model_dump()
        self._applied = None

    def _sync(self):
        try:
            saved = SGSavedPreferences.model_validate(self.storage.read_json(self.ident, 'smoothing.json'))
        except FileNotFoundError:
            saved = SGSavedPreferences()
        if self._disk_version != saved.version:
            if self._disk_version is not None:
                self._version += 1
            self._saved = saved.values.model_dump()
            self._disk_version = saved.version

    def _view(self):
        values = self._applied if self._applied is not None else self._saved
        return copy.deepcopy(dict(version=self._version, session_id=self.session_id, values=values,
            saved=self._saved, defaults=SGValues().model_dump(), unsaved=values != self._saved))

    def read(self):
        with self._lock, self.storage.lock(self.ident):
            self._sync()
            return self._view()

    def apply(self, request: SGPreferenceRequest):
        values = request.values.model_dump()
        with self._lock, self.storage.lock(self.ident):
            self._sync()
            if request.version != self._version or request.session_id != self.session_id:
                raise WebInputError('stale_revision', 'Smoothing preferences changed or the server restarted.',
                    recovery='Reload preferences, review the values and apply again.')
            if request.save:
                # Persist first so a failed write cannot apply half the change.
                next_version = self._disk_version + 1
                self.storage.write_json(self.ident, 'smoothing.json',
                    SGSavedPreferences(version=next_version, values=request.values).model_dump())
                self._saved = values
                self._disk_version = next_version
                self._applied = None
            else:
                self._applied = values
            self._version += 1
            return self._view()
