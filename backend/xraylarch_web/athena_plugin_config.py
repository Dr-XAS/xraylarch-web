"""Native reader parameters with session Apply and persistent Apply and Save."""
import copy
import threading
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool

from .errors import WebInputError
from .storage import WorkspaceStorage


class ReaderParameters(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


ColumnIndex = Annotated[int, Field(strict=True, ge=1, le=14)]
ColumnName = Annotated[str, Field(strict=True, min_length=1, max_length=128)]
Deadtime = Annotated[int, Field(strict=True, ge=0, le=10000)]


class X15BParameters(ReaderParameters):
    energy: ColumnIndex = Field(default=1, title='Energy column')
    i0: ColumnIndex = Field(default=6, title='I0 column')
    narrow: ColumnIndex = Field(default=7, title='Narrow ROI column')
    wide: ColumnIndex = Field(default=9, title='Wide ROI column')
    trans: ColumnIndex = Field(default=8, title='Transmission column')


class X23A2MEDParameters(ReaderParameters):
    energy: ColumnName = Field(default='nergy', title='Energy label', description='Native nergy is read as energy with Larch.')
    i0: ColumnName = Field(default='i0', title='I0 label')
    dt1: Deadtime = Field(default=280, title='Detector 1 deadtime (ns)')
    roi1: ColumnName = Field(default='ifch1', title='Detector 1 ROI label')
    fast1: ColumnName = Field(default='iffast1', title='Detector 1 fast label')
    slow1: ColumnName = Field(default='ifslow1', title='Detector 1 slow label')
    dt2: Deadtime = Field(default=280, title='Detector 2 deadtime (ns)')
    roi2: ColumnName = Field(default='ifch2', title='Detector 2 ROI label')
    fast2: ColumnName = Field(default='iffast2', title='Detector 2 fast label')
    slow2: ColumnName = Field(default='ifslow2', title='Detector 2 slow label')
    dt3: Deadtime = Field(default=280, title='Detector 3 deadtime (ns)')
    roi3: ColumnName = Field(default='ifch3', title='Detector 3 ROI label')
    fast3: ColumnName = Field(default='iffast3', title='Detector 3 fast label')
    slow3: ColumnName = Field(default='ifslow3', title='Detector 3 slow label')
    dt4: Deadtime = Field(default=280, title='Detector 4 deadtime (ns)')
    roi4: ColumnName = Field(default='ifch4', title='Detector 4 ROI label')
    fast4: ColumnName = Field(default='iffast4', title='Detector 4 fast label')
    slow4: ColumnName = Field(default='ifslow4', title='Detector 4 slow label')
    time: Literal['column', 'constant'] = Field(default='column', title='Integration time source')
    intcol: ColumnName = Field(default='inttime', title='Integration time label')
    inttime: float = Field(default=1., strict=True, gt=0, title='Constant integration time (s)')


MODELS = {'X15B': X15BParameters, 'X23A2MED': X23A2MEDParameters}


def parameter_model(reader):
    if reader not in MODELS:
        raise WebInputError('plugin_configuration_unavailable', 'This reader has no available configuration editor.',
                            ('reader',), 'Select a reader with a Configure button in the plugin registry.')
    return MODELS[reader]


def default_configuration(reader):
    return {'values': parameter_model(reader)().model_dump(), 'version': 0, 'session_id': 'defaults'}


class ConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(ge=0, strict=True)
    session_id: str = Field(min_length=1, max_length=128, strict=True)
    values: dict = Field(max_length=64)
    save: StrictBool = False


class SavedConfigurations(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal[1] = 1
    version: int = Field(default=0, ge=0, strict=True)
    values: dict = Field(default_factory=dict, max_length=64)


class PluginConfigurations:
    """One instance per Athena service; separate instances model app restarts.

Disk revision plus a per-instance session/revision prevents stale browser
forms from overwriting values after either another writer or a server restart.
Applying does not touch disk. Native Apply and Save writes every currently
applied reader setting, including earlier session-only edits to other readers.
"""
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
        self._saved = {}
        self._applied = {}

    def _sync(self):
        try:
            state = SavedConfigurations.model_validate(self.storage.read_json(self.ident, 'plugin-config.json'))
        except FileNotFoundError:
            state = SavedConfigurations()
        values = {name: parameter_model(name).model_validate(value).model_dump() for name, value in state.values.items()}
        if state.version != self._disk_version:
            if self._disk_version is not None:
                self._version += 1
            self._saved = values
            self._disk_version = state.version

    def _values(self, reader):
        return self._applied.get(reader, self._saved.get(reader, parameter_model(reader)().model_dump()))

    def _view(self, reader):
        model = parameter_model(reader)
        defaults = model().model_dump()
        saved = self._saved.get(reader, defaults)
        values = self._values(reader)
        return copy.deepcopy({'reader': reader, 'session_id': self.session_id, 'version': self._version,
            'values': values, 'saved': saved, 'defaults': defaults, 'unsaved': values != saved,
            'fields': [{'name': name, **field} for name, field in model.model_json_schema()['properties'].items()]})

    def read(self, reader):
        with self._lock, self.storage.lock(self.ident):
            self._sync()
            return self._view(reader)

    def apply(self, reader, request: ConfigurationRequest):
        # Validate before changing either runtime or persisted state.
        values = parameter_model(reader).model_validate(request.values).model_dump()
        with self._lock, self.storage.lock(self.ident):
            self._sync()
            if request.session_id != self.session_id or request.version != self._version:
                raise WebInputError('stale_revision', 'Reader configuration changed or the server restarted.',
                                    recovery='Reload configuration, review the values and apply again.')
            if request.save:
                all_values = {name: copy.deepcopy(self._values(name)) for name in MODELS}
                all_values[reader] = values
                next_version = self._disk_version + 1
                self.storage.write_json(self.ident, 'plugin-config.json',
                    SavedConfigurations(version=next_version, values=all_values).model_dump())
                self._saved = all_values
                self._applied = {}
                self._disk_version = next_version
            else:
                self._applied[reader] = values
            self._version += 1
            return self._view(reader)
