"""Athena File metadata controls using Larch's native XDI validator.

The validator only accesses error_message, extra_version and dspacing in its
XDIFileStruct. Python owns these buffers; no native reader or cleanup runs.
No source table, processing state or native object is changed by validation.
"""
import copy
import ctypes as C
from functools import lru_cache
import re
from threading import RLock

from pydantic import BaseModel, ConfigDict, Field

from .athena_xdi import _attributes, family_name

REQUIRED = ('Element.symbol', 'Element.edge', 'Mono.d_spacing')
RECOMMENDED = ('Facility.name', 'Facility.xray_source', 'Beamline.name', 'Scan.start_time', 'Column.1')
_LOCK = RLock()


class XDIComments(BaseModel):
    model_config = ConfigDict(extra='forbid')
    comments: str = Field(strict=True, max_length=50_000)


class XDIValidation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(strict=True, ge=0)
    family: str | None = Field(default=None, strict=True, min_length=1, max_length=128)
    tag: str | None = Field(default=None, strict=True, min_length=1, max_length=128)


def captured(group):
    source = group.get('source', {})
    metadata = source.get('xdi_metadata') or source.get('beamline_metadata')
    if metadata is None:
        metadata = dict(reader='XDI', attributes={}, comments=[], comments_text='', warnings=[],
                        input_basis='group', xdi_version='1.0', extra_version='')
        pair = source.get('edge_identity')
        if pair:
            metadata['attributes']['element'] = {k: pair[v] for k, v in [('symbol', 'element'), ('edge', 'edge')]}
    if not isinstance(metadata, dict):
        raise ValueError('Saved XDI metadata must be an object.')
    metadata = copy.deepcopy(metadata)
    metadata['attributes'] = _attributes(metadata.get('attributes', {}))
    comments = metadata.get('comments_text')
    if comments is None:
        comments = metadata.get('comments', [])
        if not isinstance(comments, list) or not all(isinstance(v, str) for v in comments):
            raise ValueError('Saved XDI comments must be text.')
        comments = '\n'.join(comments)
    if not isinstance(comments, str):
        raise ValueError('Saved XDI comments must be text.')
    metadata['comments_text'] = comments
    return metadata


def save_comments(group, text):
    metadata = captured(group)
    metadata.update(reader='XDI', comments_text=text, comments=text.splitlines())
    group['source']['xdi_metadata'] = metadata


def presence(attributes, fields):
    return [dict(field=field, present=field.split('.')[1].lower() in attributes.get(field.split('.')[0].lower(), {}))
            for field in fields]


def effective_metadata(group):
    metadata = captured(group)
    pair = group.get('source', {}).get('edge_identity')
    if pair:
        # The current absorber also supplies Element fields in native PRJ output.
        # Keep captured declarations intact in source metadata for exact exchange.
        metadata['attributes'].setdefault('element', {}).update(symbol=pair['element'], edge=pair['edge'])
    return metadata


def metadata_view(group):
    metadata = effective_metadata(group)
    attributes = metadata['attributes']
    scan = attributes.get('scan', {})
    return dict(group_id=group['id'], label=group['label'],
                xdi_version=str(metadata.get('xdi_version') or '1.0'),
                extra_version=str(metadata.get('extra_version', '')),
                families=[dict(name=family_name(metadata, f), fields=fields)
                          for f, fields in sorted(attributes.items()) if f not in {'athena', 'artemis'}],
                history=dict(process=scan.get('process', ''), start_time=scan.get('start_time'),
                    end_time=scan.get('end_time'), inherited=metadata.get('input_basis') == 'derived from acquisition metadata'),
                comments=metadata['comments_text'], required=presence(attributes, REQUIRED),
                recommended=presence(attributes, RECOMMENDED))


@lru_cache(maxsize=1)
def _validator():
    from larch.io.xdi import XDIFileStruct, get_xdilib
    try:
        library = get_xdilib()
        function = library.XDI_validate_item
        function.argtypes = [C.POINTER(XDIFileStruct), C.c_char_p, C.c_char_p, C.c_char_p]
        function.restype = C.c_int
    except (OSError, AttributeError, TypeError, ImportError) as exc:
        raise ValueError('The Larch XDI validator is unavailable in this installation.') from exc
    return XDIFileStruct, function


def validate_fields(metadata, family=None, tag=None):
    attributes = _attributes(metadata.get('attributes', {}))
    if (family is None) != (tag is None):
        raise ValueError('Choose both a family and a field, or validate all fields.')
    if family is not None and (family.lower() not in attributes or tag.lower() not in attributes[family.lower()]):
        raise ValueError('The selected XDI field does not exist. Reload metadata before retrying.')
    selected = [(family.lower(), tag.lower())] if family is not None else [
        (f, t) for f, fields in sorted(attributes.items()) if f not in {'athena', 'artemis'} for t in sorted(fields)]
    if len(selected) > 5000:
        raise ValueError('XDI validation supports at most 5000 fields per request.')
    extra = str(metadata.get('extra_version', ''))
    if '\0' in extra or len(extra.encode()) > 8192:
        raise ValueError('XDI application versions must fit within 8192 bytes and contain no null characters.')
    results = []
    with _LOCK:
        Struct, function = _validator()
        for f, t in selected:
            name = family_name(metadata, f)
            value = attributes[f][t].strip()
            # Native DoContextMenu lowercases a single field's value; ValidateAll
            # preserves case. Keep this observable distinction without altering data.
            tested = value.lower() if family is not None else value
            if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name) or not re.fullmatch(r'[A-Za-z_0-9]+', t):
                code, message = None, 'This family or field name is not a valid XDI identifier.'
            elif any('\0' in s or len(s.encode()) > 8192 for s in (name, t, tested)):
                code, message = None, 'XDI fields must fit within 8192 bytes and contain no null characters.'
            else:
                error = C.create_string_buffer(4096)
                version = C.create_string_buffer(extra.encode())
                state = Struct(error_message=C.cast(error, C.c_char_p), extra_version=C.cast(version, C.c_char_p))
                inputs = [C.create_string_buffer(s.encode()) for s in (name, t, tested)]
                code = function(C.pointer(state), *inputs)
                message = error.value.decode('utf-8', errors='replace') if code else ''
            results.append(dict(family=name, tag=t, value=attributes[f][t], code=code,
                                valid=code == 0, message=message))
    return dict(engine='Larch XDI', mode='field' if family is not None else 'all',
                results=results, valid=all(row['valid'] for row in results))
