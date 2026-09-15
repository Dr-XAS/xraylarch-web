"""Read Athena's Data::Dumper literals as inert data, without running Perl.

Python literal_eval is only the final decoder. Perl strings and hash arrows
must first be translated, and blessed XDI objects retain their class as data.
"""
from __future__ import annotations

import ast
import re


class _NativeData(ast.NodeTransformer):
    def visit_Name(self, node):
        return ast.Constant(value=None) if node.id == "undef" else node

    def visit_Call(self, node):
        # Data::Dumper emits bless({...}, 'Xray::XDI'). Never instantiate the
        # named class or permit general calls, including inside its payload.
        if (not isinstance(node.func, ast.Name) or node.func.id != "bless"
                or len(node.args) != 2 or node.keywords
                or not isinstance(node.args[0], (ast.Dict, ast.List))
                or not isinstance(node.args[1], ast.Constant)
                or not isinstance(node.args[1].value, str)):
            raise ValueError("Native projects may contain literal data, not executable expressions.")
        return ast.Dict(keys=[ast.Constant(value="__perl_class__"), ast.Constant(value="__perl_value__")],
                        values=[node.args[1], self.visit(node.args[0])])


def _string(text, start, legacy_strings):
    quote = text[start]
    result, i = [], start + 1
    escapes = {"n": "\n", "r": "\r", "t": "\t", "f": "\f", "b": "\b", "a": "\a", "e": "\x1b"}
    while i < len(text):
        char = text[i]
        i += 1
        if char == quote:
            return repr("".join(result)), i
        if char != "\\":
            result.append(char)
            continue
        if i == len(text):
            break
        escaped = text[i]
        i += 1
        if escaped in ("\\", quote):
            result.append(escaped)
        elif quote == "'" and not legacy_strings:
            # Perl single quotes do not interpret \n, \t or Windows paths.
            result.append("\\" + escaped)
        elif escaped in escapes:
            result.append(escapes[escaped])
        elif escaped in ("$", "@", "'"):
            result.append(escaped)
        elif escaped == "x":
            if text[i:i + 1] == "{":
                end = text.find("}", i + 1)
                digits = text[i + 1:end] if end >= 0 else ""
                i = end + 1
            else:
                digits = text[i:i + 2]
                i += 2
            if not re.fullmatch(r"[0-9a-fA-F]{1,6}", digits):
                raise ValueError("Invalid hexadecimal escape in native project text.")
            result.append(chr(int(digits, 16)))
        elif escaped in "01234567":
            digits = escaped
            while len(digits) < 3 and i < len(text) and text[i] in "01234567":
                digits += text[i]
                i += 1
            result.append(chr(int(digits, 8)))
        elif legacy_strings and escaped in ("u", "U"):
            count = 4 if escaped == "u" else 8
            digits = text[i:i + count]
            if len(digits) != count or not re.fullmatch(r"[0-9a-fA-F]+", digits):
                raise ValueError("Invalid Unicode escape in web project text.")
            result.append(chr(int(digits, 16)))
            i += count
        else:
            result.append("\\" + escaped)
    raise ValueError("Unterminated quoted string in native project.")


def project_literal(text, *, legacy_strings=False):
    if len(text) > 8_000_000:
        raise ValueError("A native project literal exceeds 8 MB; split or rebin the project.")
    pieces, brackets, i = [], [], 0
    while i < len(text):
        char = text[i]
        if char in ("'", '"'):
            value, i = _string(text, i, legacy_strings)
            pieces.append(value)
            continue
        if text[i:i + 2] == "=>":
            pieces.append(":" if brackets and brackets[-1] == "{" else ",")
            i += 2
            continue
        if char in "([{":
            brackets.append(char)
            if len(brackets) > 32:
                raise ValueError("Native project literals exceed 32 nesting levels.")
        elif char in ")]}":
            if not brackets or brackets.pop() != {")": "(", "]": "[", "}": "{"}[char]:
                raise ValueError("Unbalanced delimiters in native project.")
        pieces.append(char)
        i += 1
    tree = ast.parse("".join(pieces).strip().removesuffix(";"), mode="eval")
    # Reject duplicate keys instead of silently losing metadata.
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = [ast.literal_eval(key) for key in node.keys]
            if any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys):
                raise ValueError("Native hash keys must be unique strings.")
    return ast.literal_eval(_NativeData().visit(tree))


def project_statements(text):
    """Yield full assignments, including physical newlines within strings."""
    pending, quote, escaped, depth, size = [], None, False, 0, 0
    for raw in text.splitlines(keepends=True):
        if not pending and not (raw.lstrip().startswith(("$", "@", "%")) and "=" in raw):
            yield raw
            continue
        pending.append(raw)
        size += len(raw)
        if size > 8_000_000:
            raise ValueError("A native project literal exceeds 8 MB; split or rebin the project.")
        for char in raw:
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in ("'", '"'):
                quote = char
            elif char in "([{":
                depth += 1
            elif char in ")]}":
                depth -= 1
        if not quote and depth == 0:
            yield "".join(pending)
            pending, size = [], 0
    if pending:
        raise ValueError("Unterminated native project assignment.")
