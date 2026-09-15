"""Native XDI cloning and accumulated Scan.process for Athena derivatives."""
import copy

from .athena_xdi import _attributes, family_name


def clone_metadata(metadata, element, edge, process='', remove_times=0):
    """Clone metadata, matching Data::XDI::xdi_make_clone without C handles.

    Native remove_times < 0 removes only end_time; > 0 removes both. Original
    acquisition column descriptors/counts remain metadata, never detector arrays
    attached to the transformed numerical grid.
    """
    out = copy.deepcopy(metadata)
    attrs = _attributes(out.get('attributes', {}))
    original = out.get('native_object')
    if isinstance(original, dict) and _attributes(original.get('metadata', {})) != attrs:
        raise ValueError('Saved XDI fields disagree with the retained native object; repair the source before cloning.')
    if not isinstance(process, str):
        raise ValueError('XDI processing history must be text.')
    if remove_times:
        scan = attrs.setdefault('scan', {})
        if remove_times > 0:
            scan.pop('start_time', None)
        scan.pop('end_time', None)
    if element and edge:
        attrs.setdefault('element', {}).update(symbol=element.capitalize(), edge=edge.upper())
    prior = attrs.get('scan', {}).get('process', '')
    # Match Perl truth, including the string "0". Native straight copies of
    # existing history append "; "; retain that text instead of normalizing it.
    if prior not in ('', '0'):
        process = prior + '; ' + process
    if process not in ('', '0'):
        attrs.setdefault('scan', {})['process'] = process
    out['attributes'] = attrs
    if isinstance(original, dict):
        native_attrs = original.get('metadata', {})
        updated = {}
        for family, fields in attrs.items():
            name = family_name(out, family)
            previous = native_attrs.get(name, {})
            updated[name] = {next((k for k in previous if k.lower() == tag), tag): value for tag, value in fields.items()}
        original['metadata'] = updated
        # These are NoClone attributes in Xray::XDI. Never duplicate a reader
        # error or source table onto a derived XDI object.
        original.update(errorcode=0, errormessage='', filename='', data={})
        original.pop('xdifile', None)
    out['input_basis'] = 'derived from acquisition metadata'
    return out


def operation_description(operation, details):
    if operation == 'smooth':
        method = details.get('options', {}).get('method')
        if method in ('boxcar', 'gaussian'):
            return ('Smoothed data by boxcar average' if method == 'boxcar' else 'Smoothed data by Gaussian filter'), 0
        if method == 'three_point':
            count = details.get('details', {}).get('repetitions', 1)
            return f'Smoothed data by three-point filter ({count} repetitions)', 0
    if operation == 'remove_points':
        return f"Removed {details['count']} points by {details['action']}", 0
    if operation == 'convolve':
        options = details.get('options', {})
        messages = ['Convolved data with a broadening function'] if options.get('width', 0) > 0 else []
        if options.get('noise', 0) > 0:
            noise = details.get('details', {})
            messages.append(f"Added normal noise (sigma {noise.get('noise_sigma'):g}, seed {noise.get('seed')})"
                            if noise.get('noise_sigma') is not None else 'Added normal noise')
        return '; '.join(messages), 0
    if operation == 'merge':
        return f"Merge of {len(details.get('parents', []))} scans", -1
    if operation == 'sum':
        # The native summer has no explicit XDI history call. Preserve the
        # primary scan's acquisition fields and describe the web operation.
        return f"Weighted sum of {len(details.get('parents', []))} scans", 0
    if operation == 'difference':
        return 'Difference spectrum', 0
    return {
        'duplicate': ('', 0),
        # Native Series calls the same UI::Group::Copy routine for each value.
        'copy_series': ('', 0),
        'rebin': ('Data rebinned onto a three-region energy grid', 0),
        'multi_electron': ('Removed multi-electron excitation', 0),
        # Explicit SG uses Larch; method-less legacy requests use generalized SG.
        'smooth': ('Smoothed data by Savitzky-Golay filter', 0),
        'deglitch': ('Replaced selected glitches by interpolation', 0),
        'truncate': ('Truncated data to the selected interval', 0),
        'convolve': ('Convolved data with a broadening function', 0),
        'deconvolve': ('Deconvolved normalized data', 0),
        'self_absorption': ('Corrected fluorescence self-absorption', 0),
        'dispersive': ('Calibrated dispersive energy scale', 0),
    }.get(operation, (operation.replace('_', ' ').capitalize(), 0))


def inherit_source(parent, operation, details):
    source = parent.get('source', {})
    metadata = source.get('xdi_metadata') or source.get('beamline_metadata')
    if metadata is None:
        # Native file metadata has an Element family even without a recognized
        # beamline header; do not lose processing history for ordinary ASCII.
        metadata = dict(reader='XDI', attributes={}, comments=[], comments_text='',
            xdi_version='1.0', extra_version='', warnings=[])
    if not isinstance(metadata, dict):
        raise ValueError('Saved XDI metadata must be an object.')
    identity = source.get('edge_identity', {})
    effective = (parent.get('result') or {}).get('effective', {})
    element, edge = identity.get('element', effective.get('element')), identity.get('edge', effective.get('edge'))
    process, remove_times = operation_description(operation, details)
    return clone_metadata(metadata, element, edge, process, remove_times)
