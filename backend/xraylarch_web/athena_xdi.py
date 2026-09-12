"""XDI acquisition metadata and inert native Xray::XDI project objects.

Arrays are read by Larch. Project literals never instantiate Perl classes.
The native object shape follows Xray::XDI 1.00 serialize (XDI ed21ad5).
"""
import copy
import hashlib
import math
import re


def _attributes(value):
    if not isinstance(value, dict):
        raise ValueError('XDI metadata must contain named families.')
    result = {}
    for family, fields in value.items():
        if not isinstance(family, str) or not isinstance(fields, dict):
            raise ValueError('XDI metadata families must contain named fields.')
        family = family.lower()
        if family in result:
            raise ValueError('XDI metadata has duplicate case-insensitive families.')
        result[family] = {}
        for tag, text in fields.items():
            if not isinstance(tag, str) or not isinstance(text, (str, int, float)) or isinstance(text, bool):
                raise ValueError('XDI metadata values must be text or finite numbers.')
            if isinstance(text, float) and not math.isfinite(text):
                raise ValueError('XDI metadata values must be finite.')
            if tag.lower() in result[family]:
                raise ValueError('XDI metadata has duplicate case-insensitive fields.')
            result[family][tag.lower()] = str(text)
    return result


def from_larch(group, source):
    """Capture the actual Larch reader's metadata alongside its numeric data."""
    comments = str(getattr(group, 'comments', ''))
    families = {}
    for line in source.decode('utf-8-sig').splitlines():
        if re.match(r'^\s*#\s*(?:///|---)', line):
            break
        field = re.match(r'^\s*#\s*([A-Za-z_][A-Za-z_0-9]*)\.[^:\n]+:', line)
        if field:
            families[field[1].lower()] = field[1]
    return dict(reader='XDI', attributes=_attributes(group.attrs), comments=comments.splitlines(),
                comments_text=comments, warnings=[], input_basis='original',
                source_sha256=hashlib.sha256(source).hexdigest(),
                xdi_version=str(group.xdi_version), xdi_libversion=str(group.xdi_libversion), extra_version=str(group.extra_version),
                family_names=families,
                array_labels=list(group.array_labels), array_units=list(group.array_units), npts=int(group.npts))


def from_native(value):
    """Promote a recognized literal, retaining its exact object separately."""
    if not isinstance(value, dict) or value.get('__perl_class__') != 'Xray::XDI':
        return None
    obj = value.get('__perl_value__')
    if not isinstance(obj, dict):
        raise ValueError('The native XDI object must contain literal fields.')
    comments = obj.get('comments', '')
    if not isinstance(comments, str):
        raise ValueError('Native XDI comments must be text.')
    # Data::Athena stringifies line breaks; Data::Prj restores them after eval.
    comments = comments.replace('\\n', '\n')
    return dict(reader='XDI', attributes=_attributes(obj.get('metadata', {})), comments=comments.splitlines(),
                comments_text=comments, warnings=[], input_basis='native project',
                xdi_version=str(obj.get('xdi_version', '')), extra_version=str(obj.get('extra_version', '')),
                xdi_libversion=str(obj.get('xdi_libversion', '')),
                native_object=copy.deepcopy(obj))


def identity(metadata):
    """Only the explicit standard Element family supplies absorber identity."""
    from .athena_e0 import atomic_edge
    fields = metadata.get('attributes', {}).get('element', {})
    try:
        found = atomic_edge(fields.get('symbol'), fields.get('edge'))
    except ValueError:
        return None
    return dict(element=found['element'], edge=found['edge'], origin='xdi')


def family_name(metadata, family):
    """Retain family spelling for native extension-version matching."""
    obj = metadata.get('native_object')
    original = obj.get('metadata', {}) if isinstance(obj, dict) else {}
    if isinstance(original, dict):
        found = next((f for f in original if isinstance(f, str) and f.lower() == family), None)
        if found:
            return found
    names = metadata.get('family_names', {})
    if isinstance(names, dict) and isinstance(names.get(family), str) and names[family].lower() == family:
        return names[family]
    if family not in {'element', 'mono', 'facility', 'beamline', 'detector', 'sample', 'scan', 'column'}:
        # Older saved Larch/helper metadata folded family names to lowercase.
        # Recover the spelling from its version token for native extension checks.
        for token in str(metadata.get('extra_version', '')).split():
            if token.split('/')[0].lower() == family:
                return token.split('/')[0]
    return family.capitalize()


def _literal(value):
    """Emit inert Perl data, with interpolation and control characters escaped."""
    if value is None:
        return 'undef'
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError('Native XDI fields must be finite.')
        return repr(value)
    if isinstance(value, str):
        text = ''
        for char in value:
            if char in '\\"$@':
                text += '\\' + char
            elif not 32 <= ord(char) < 127:
                text += '\\x{' + format(ord(char), 'x') + '}'
            else:
                text += char
        return '"' + text + '"'
    if isinstance(value, list):
        return '[' + ','.join(_literal(v) for v in value) + ']'
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return '{' + ','.join(_literal(k) + ' => ' + _literal(v) for k, v in value.items()) + '}'
    raise ValueError('Native XDI objects may contain literal data only.')


def project_statement(source, group_identity=None):
    metadata = source.get('xdi_metadata') or source.get('beamline_metadata')
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise ValueError('Saved XDI acquisition metadata must be an object.')
    attrs = _attributes(metadata.get('attributes', {}))
    # A native object imported earlier retains original family/tag spelling
    # and auxiliary fields. Fresh Larch metadata uses case-insensitive names.
    original = metadata.get('native_object')
    if isinstance(original, dict) and _attributes(original.get('metadata', {})) != attrs:
        raise ValueError('Saved XDI fields disagree with the retained native object.')
    obj = copy.deepcopy(original) if isinstance(original, dict) else dict(
        file='', filename='', errorcode=1, errormessage='', xdi_libversion=str(metadata.get('xdi_libversion', '')),
        xdi_version=str(metadata.get('xdi_version', '1.0')), extra_version=str(metadata.get('extra_version', '')),
        element='', edge='', dspacing=0, nmetadata=sum(len(fields) for fields in attrs.values()), npts=metadata.get('npts', 0),
        narrays=len(metadata.get('array_labels', [])), narray_labels=len(metadata.get('array_labels', [])),
        array_labels=metadata.get('array_labels', []), array_units=metadata.get('array_units', []),
        metadata={family_name(metadata, family): fields for family, fields in attrs.items()})
    # XDI serialize clears its table; Athena's @x/@y carry group observations.
    # Foreign C handles are NoClone attributes and must never be serialized.
    obj.pop('xdifile', None)
    obj['data'] = {}
    if not isinstance(original, dict):
        try:
            spacing = float(attrs.get('mono', {}).get('d_spacing', 0))
            if math.isfinite(spacing):
                obj['dspacing'] = spacing
        except (TypeError, ValueError, OverflowError):
            pass  # Retain an uninterpretable header field without inventing geometry.
    obj['comments'] = metadata.get('comments_text', '\n'.join(metadata.get('comments', [])))
    if not isinstance(obj['comments'], str):
        raise ValueError('Saved XDI comments must be text.')
    if group_identity:
        family = next((k for k in obj['metadata'] if k.lower() == 'element'), 'Element')
        fields = obj['metadata'].setdefault(family, {})
        for tag, value in [('symbol', group_identity['element']), ('edge', group_identity['edge'])]:
            original_tag = next((k for k in fields if k.lower() == tag), tag)
            fields[original_tag] = value
        obj.update(element=group_identity['element'], edge=group_identity['edge'])
    return "$xdi = bless(" + _literal(obj) + ", 'Xray::XDI');"
