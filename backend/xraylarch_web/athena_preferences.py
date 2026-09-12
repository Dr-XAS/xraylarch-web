"""Local Athena preferences, separate from project data and undo history."""
import copy
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_rebin import ImportRebin
from .errors import WebInputError
from .storage import WorkspaceStorage
from .athena_plugin_registry import PluginRegistry
from .athena_beamline_metadata import BeamlineDefaults


class RebinGrid(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    emin: float = Field(default=-30., strict=True)
    emax: float = Field(default=50., strict=True)
    pre: float = Field(default=10., strict=True, gt=0)
    xanes: float = Field(default=.5, strict=True, gt=0)
    exafs: float = Field(default=.05, strict=True, gt=0)
    width: int = Field(default=3, strict=True, ge=1, le=11)

    @model_validator(mode='after')
    def boundaries(self):
        if self.emin == self.emax or max(self.emin, self.emax) <= 0:
            raise ValueError('Rebin boundaries must differ and end above E0.')
        # Keep the preference contract compatible with the scientific request.
        ImportRebin.model_validate(self.model_dump())
        return self


class RebinDefaults(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(default=0, strict=True, ge=0)
    grid: RebinGrid = Field(default_factory=RebinGrid)


class RememberedColumn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    column_id: str = Field(min_length=1, max_length=128, strict=True)
    name: str = Field(min_length=1, max_length=1000, strict=True)


class ColumnMemory(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal[1] = 1
    version: int = Field(ge=1, strict=True)
    columns: list[RememberedColumn] = Field(min_length=1, max_length=64)
    mapping: dict[str, Any]
    project_id: str = Field(min_length=1, max_length=128, strict=True)
    standard_label: str | None = Field(default=None, max_length=1000, strict=True)
    grid: RebinGrid

    @model_validator(mode='after')
    def valid_mapping(self):
        # ImportRequest is the scientific boundary. Delay its import to avoid
        # the module dependency cycle, and validate stored data on every read.
        from .athena import ImportRequest
        req = ImportRequest.model_validate({'version': 0, 'upload_id': '', **self.mapping})
        if set(self.mapping) & {'version', 'upload_id', 'edge_policy', 'rebin_grid'}:
            raise ValueError('Column memory contains file or batch-specific state.')
        ids = [c.column_id for c in self.columns]
        if len(ids) != len(set(ids)):
            raise ValueError('Remembered columns must have distinct IDs.')
        den = req.denominator if isinstance(req.denominator, list) else [req.denominator]
        if len(set(req.numerator)) != len(req.numerator) or len(set(den)) != len(den):
            raise ValueError('Remembered detector operands contain repeated columns.')
        selected = [req.energy_column, *req.numerator, *den, req.reference_numerator, req.reference_denominator]
        if any(key not in ids and key not in (None, '', '1') for key in selected) or req.energy_column not in ids:
            raise ValueError('Remembered selections refer to unavailable columns.')
        return self


class AthenaPreferences:
    def __init__(self, settings):
        self.storage = WorkspaceStorage(settings.data_root / 'preferences')
        self.ident = 'athena_preferences'
        try:
            self.storage.workspace_dir(self.ident, create=True)
        except FileExistsError:
            pass

    def read(self):
        try:
            return RebinDefaults.model_validate(self.storage.read_json(self.ident, 'rebin.json')).model_dump()
        except FileNotFoundError:
            return RebinDefaults().model_dump()

    def read_dispersive(self):
        from .athena_dispersive import DispersiveDefaults
        try:
            return DispersiveDefaults.model_validate(self.storage.read_json(self.ident,'dispersive.json')).model_dump()
        except FileNotFoundError:
            return DispersiveDefaults().model_dump()

    def read_merge(self):
        from .athena_merge import MergeDefaults
        try:
            return MergeDefaults.model_validate(self.storage.read_json(self.ident,'merge.json')).model_dump()
        except FileNotFoundError:
            return MergeDefaults().model_dump()

    def save_merge(self,request):
        from .athena_merge import MergeDefaults
        request=MergeDefaults.model_validate(request)
        with self.storage.lock(self.ident):
            previous=self.read_merge()
            if previous['version']!=request.version:
                raise WebInputError('stale_revision','Merge preferences changed in another window.',
                    recovery='Reload the merge preferences, review them and save again.')
            value=dict(version=previous['version']+1,values=request.values.model_dump())
            self.storage.write_json(self.ident,'merge.json',value)
            return value

    def save_dispersive(self,request):
        from .athena_dispersive import DispersiveDefaults
        request=DispersiveDefaults.model_validate(request)
        with self.storage.lock(self.ident):
            previous=self.read_dispersive()
            if previous['version']!=request.version:
                raise WebInputError('stale_revision','Dispersive calibration changed in another window.',
                    recovery='Load the saved calibration, review the coefficients and save again.')
            if request.coefficients is None:
                raise ValueError('Supply all three calibration coefficients.')
            value=dict(version=previous['version']+1,coefficients=request.coefficients.model_dump())
            self.storage.write_json(self.ident,'dispersive.json',value)
            return value

    def read_plugins(self):
        try:
            return PluginRegistry.model_validate(self.storage.read_json(self.ident, 'plugins.json')).model_dump()
        except FileNotFoundError:
            # Native PluginRegistry.pm starts unchecked when no YAML exists.
            return PluginRegistry().model_dump()

    def read_beamline(self):
        try:
            return BeamlineDefaults.model_validate(self.storage.read_json(self.ident, 'beamline.json')).model_dump()
        except FileNotFoundError:
            return BeamlineDefaults().model_dump()

    def save_beamline(self, request: BeamlineDefaults):
        with self.storage.lock(self.ident):
            current = self.read_beamline()
            if request.version != current['version']:
                raise WebInputError('stale_revision', 'Beamline identification settings changed in another window.',
                                    recovery='Reload the settings, review the switch and save again.')
            result = {'version': current['version'] + 1, 'enabled': request.enabled}
            self.storage.write_json(self.ident, 'beamline.json', result)
            return result

    def save_plugins(self, request: PluginRegistry):
        with self.storage.lock(self.ident):
            current = self.read_plugins()
            if request.version != current['version']:
                raise WebInputError('stale_revision', 'File-plugin settings changed in another window.',
                                    recovery='Reload plugin settings, review the switches and try again.')
            result = {'version': current['version'] + 1, 'enabled': dict(request.enabled)}
            self.storage.write_json(self.ident, 'plugins.json', result)
            return result

    def save(self, request: RebinDefaults):
        with self.storage.lock(self.ident):
            current = self.read()
            if current['version'] != request.version:
                raise WebInputError('stale_revision', 'Rebin defaults changed in another window.',
                                    recovery='Load saved defaults, review the grid, and save again.')
            result = {'version': current['version'] + 1, 'grid': request.grid.model_dump()}
            self.storage.write_json(self.ident, 'rebin.json', result)
            return result

    def read_columns(self):
        try:
            return ColumnMemory.model_validate(self.storage.read_json(self.ident, 'columns.json'))
        except FileNotFoundError:
            return None

    def remember_columns(self, inspection, request, project):
        """Only call after a successful import; most recently accepted wins."""
        with self.storage.lock(self.ident):
            previous = self.read_columns()
            choice = request.rebin_grid or request.rebin
            grid = ({k: getattr(choice, k) for k in RebinGrid.model_fields} if choice is not None
                    else previous.grid.model_dump() if previous else self.read()['grid'])
            standard = next((g for g in project['groups'] if request.preprocessing
                             and g['id'] == request.preprocessing.standard_id), None)
            mapping = request.model_dump(exclude={'version', 'upload_id', 'edge_policy', 'rebin_grid'})
            if mapping.get('rebin') is not None:
                mapping['rebin'].pop('e0', None)  # Keep file-specific E0 only in the group's provenance.
            record = ColumnMemory(version=previous.version + 1 if previous else 1,
                columns=[{k: c[k] for k in ('column_id', 'name')} for c in inspection['columns']],
                mapping=mapping,
                project_id=project['id'], standard_label=standard['label'] if standard else None, grid=grid)
            self.storage.write_json(self.ident, 'columns.json', record.model_dump())

    def column_choices(self, inspection, project):
        """Restore by ordered labels/positions, not by a coincidental column ID."""
        memory = self.read_columns()
        if memory is None:
            return None
        columns = inspection['columns']
        matching = [c.name for c in memory.columns] == [c['name'] for c in columns]
        old = memory.mapping
        mapping = copy.deepcopy(old if matching else inspection['athena_suggestion'])
        warnings = []
        if matching:
            ids = {a.column_id: b['column_id'] for a, b in zip(memory.columns, columns, strict=True)}
            def convert(value):
                if isinstance(value, list): return [convert(v) for v in value]
                return ids.get(value, value) or ''
            for key in ('energy_column', 'numerator', 'denominator', 'reference_numerator', 'reference_denominator'):
                mapping[key] = convert(mapping.get(key))
        else:
            mapping.update(reference_numerator='', reference_denominator='', reference_log=True,
                           reference_same_element=True, individual_channels=False,
                           signal_multiplier=old.get('signal_multiplier', 1), invert=old.get('invert', False))
        mapping['sort'] = old.get('sort', False)
        mapping['rebin'] = {'enabled': matching and old.get('rebin') is not None,
                            'e0': None, **memory.grid.model_dump(), 'width': self.read()['grid']['width']}
        prep = copy.deepcopy(old.get('preprocessing') or
                             {'mark': False, 'standard_id': None, 'copy_parameters': False, 'align': False})
        if prep['standard_id']:
            # IO.pm restores the first matching name in list order, even when
            # another group has the saved ID. A renamed group no longer matches.
            standard = next((g for g in project['groups'] if g['label'] == memory.standard_label), None)
            if (standard and standard['data_type'] not in ('chi', 'detector') and not standard.get('is_difference')
                    and standard.get('source', {}).get('operation') != 'difference'
                    and standard.get('result') and not standard.get('processing_error')):
                prep['standard_id'] = standard['id']
            else:
                prep.update(standard_id=None, copy_parameters=False, align=False)
                warnings.append('The remembered preprocessing standard is missing or unusable. Choose a standard to copy parameters or align.')
        mapping['preprocessing'] = prep
        if mapping['data_type'] == 'chi':
            mapping.update(mode='mu', units='eV', denominator='', reference_numerator='', reference_denominator='',
                           signal_multiplier=1., invert=False)
            mapping['rebin']['enabled'] = False
            prep.update(standard_id=None, copy_parameters=False, align=False)
        return {'version': memory.version, 'matching_columns': matching, 'mapping': mapping, 'warnings': warnings}
