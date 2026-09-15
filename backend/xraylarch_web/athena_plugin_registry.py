"""Persistent Athena file-plugin choices and native YAML exchange."""
import re

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
import yaml

from .athena_file_plugins import plugin_catalog
from .errors import WebInputError

_NAME = re.compile(r'Demeter::Plugins::[A-Za-z0-9_]{1,100}\Z')
MAX_REGISTRY_BYTES = 64_000


class PluginRegistry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(default=0, ge=0, strict=True)
    enabled: dict[str, StrictBool] = Field(default_factory=dict, max_length=256)

    @field_validator('enabled')
    @classmethod
    def names(cls, value):
        if any(not _NAME.fullmatch(name) or name.endswith('::FileType') for name in value):
            raise ValueError('Use Athena file-plugin names such as Demeter::Plugins::X10C.')
        return value


def registry_view(state):
    return {**state, 'plugins': plugin_catalog()}


def decode_registry(data):
    """Only a flat scalar mapping is meaningful in Athena's registry file."""
    def invalid(message='Supply an Athena plugin registry containing plugin names and 0/1 or true/false values.'):
        raise WebInputError('plugin_registry_invalid', message, ('file',),
                            'Choose an athena.plugin_registry file or correct its entries, then retry.')
    if len(data) > MAX_REGISTRY_BYTES:
        invalid('Plugin registry files must be no larger than 64 KB.')
    try:
        text = data.decode('utf-8-sig')
        # A native YAML::Tiny dump has no aliases, anchors or object tags.
        for token in yaml.scan(text):
            if isinstance(token, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken, yaml.tokens.TagToken)):
                invalid()
        node = yaml.compose(text, Loader=yaml.BaseLoader)
        if not isinstance(node, yaml.MappingNode) or len(node.value) > 256:
            invalid()
        flags = {}
        for key, value in node.value:
            if not isinstance(key, yaml.ScalarNode) or not isinstance(value, yaml.ScalarNode):
                invalid()
            if key.value in flags:
                invalid(f'Duplicate plugin entry: {key.value}.')
            if value.value.lower() not in ('0', '1', 'false', 'true'):
                invalid()
            flags[key.value] = value.value.lower() in ('1', 'true')
        return PluginRegistry(enabled=flags).enabled
    except (UnicodeError, yaml.YAMLError, ValueError, RecursionError) as exc:
        invalid(str(exc) if isinstance(exc, ValueError) and not isinstance(exc, yaml.YAMLError) else
                'The plugin registry is not a valid flat Athena YAML mapping.')


def encode_registry(state):
    flags = {p['id']: False for p in plugin_catalog()} | state['enabled']
    return ('---\n' + ''.join(f'{name}: {int(flags[name])}\n' for name in sorted(flags))).encode()
