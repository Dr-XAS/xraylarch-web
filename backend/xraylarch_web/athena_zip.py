"""Athena Zip list-output reader; archive paths are labels, never disk paths."""
from dataclasses import dataclass
import hashlib
from io import BytesIO
import lzma
import stat
import zipfile
import zlib

from .errors import WebInputError


@dataclass(frozen=True)
class PreparedArchive:
    members: list[dict]
    metadata: dict


def recognize(data):
    return data.startswith((b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08')) or zipfile.is_zipfile(BytesIO(data))


def invalid(message, code='archive_invalid'):
    raise WebInputError(code, message, ('file',),
                        'Choose a valid, unencrypted ZIP of data files within the upload limits.')


def read_archive(data, max_bytes, member_index=None):
    """Check all byte/CRC boundaries before making a list available.

    Names may repeat or contain directories: central-directory ordinal is the
    identity. No member is extracted to a filesystem path. Limit metadata too,
    so tiny/empty entries cannot create an unbounded browser list.
    """
    if len(data) > max_bytes:
        invalid(f'ZIP exceeds the {max_bytes} byte upload limit.', 'upload_too_large')
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            # Athena IO.pm calls Files::is_zipproj('guess') before plugins.
            # These root members identify fitting projects, outside Athena.
            if any(item.filename in ('order', 'gds.yaml', 'HORAE') for item in entries):
                invalid('This ZIP is an Artemis project or fit serialization, which Athena cannot import.',
                        'archive_project_unsupported')
            if len(entries) > 1000:
                invalid('ZIP contains more than 1,000 entries.', 'archive_too_many_entries')
            if sum(item.file_size for item in entries) > max_bytes:
                invalid(f'Expanded ZIP exceeds the {max_bytes} byte upload limit.', 'upload_too_large')
            members = []
            selected = None
            for index, item in enumerate(entries):
                if item.flag_bits & 1:
                    invalid('Password-protected ZIP entries are not supported.')
                mode = stat.S_IFMT(item.external_attr >> 16)
                if mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                    invalid('ZIP contains a link or special file; choose an archive of regular data files.')
                if item.is_dir():
                    continue
                if member_index is not None and member_index != index:
                    continue
                # ZipInfo, not its name: duplicate names refer to different
                # observations. The bounded read verifies size and CRC too.
                with archive.open(item) as stream:
                    content = stream.read(max_bytes + 1)
                if len(content) != item.file_size or len(content) > max_bytes:
                    invalid('ZIP entry size does not match its directory record.')
                name = item.filename
                if any(ord(c) < 32 or ord(c) == 127 for c in name) or '\x00' in item.orig_filename:
                    invalid('ZIP entry names must not contain control characters.')
                members.append(dict(index=index, name=name, bytes=len(content),
                                    sha256=hashlib.sha256(content).hexdigest()))
                if member_index == index:
                    selected = content, name
            if member_index is not None:
                if selected is None:
                    invalid('Choose a file entry from this ZIP.', 'archive_member_unavailable')
                return selected
            if not members:
                invalid('ZIP contains no data files.', 'upload_empty')
            return PreparedArchive(members, dict(id='Zip', version='0.1',
                description='ZIP archive of data files',
                summary='Choose files in archive order, then review each file’s columns or project groups.',
                source_sha256=hashlib.sha256(data).hexdigest(), original_bytes=len(data),
                expanded_bytes=sum(m['bytes'] for m in members), directory_count=len(entries)-len(members)))
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, RuntimeError, EOFError,
            zlib.error, lzma.LZMAError, UnicodeError, OSError) as exc:
        invalid(f'ZIP could not be read: {exc}')
