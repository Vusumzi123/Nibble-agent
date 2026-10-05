#!/usr/bin/env python3
"""Shared stdlib-only reader for sysop-config.yaml.

The sole Python consumer of the config is ``openjevserver.py``, which
previously carried its own hand-rolled ``decisions:`` scanner. The section is a
flat indented scalar block, so this module provides one dependency-free reader
for it (no PyYAML under scripts/).

Exports:
    expand_home(value, home=None)          -> str
    resolve_root(base, value)              -> str
    resolve_leaf(root, value)              -> str
    read_block(path, section)              -> dict[str, str]   (raw scalars)
    coerce(value)                          -> bool | int | float | str
    read_section(path, section, defaults)  -> dict              (coerced overlay)

Coordinate with .opencode/plugin/lib/config.ts: that module owns the TS side's
per-section coercion; this one keeps the Python side intentionally value-typed
(the shape the openjevserver reader already used).
"""

from __future__ import annotations

import os
import re
from typing import Any

# `key:` line inside an indented block. Mirrors openjevserver's reader plus a
# hyphen allowance so the same helper can read `paths:` too.
_KEY_RE = re.compile(r"^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$")


def expand_home(value: str, home: str | None = None) -> str:
    """Expand a leading ``~`` (bare or ``~/...``) against ``home``."""
    home = home if home is not None else os.path.expanduser("~")
    if value == "~":
        return home
    if value.startswith("~/"):
        return os.path.join(home, value[2:])
    return value


def resolve_root(base: str, value: str) -> str:
    """Resolve a canonical root: expanduser, then join onto ``base`` if relative."""
    value = expand_home(value)
    if os.path.isabs(value):
        return os.path.normpath(value)
    return os.path.normpath(os.path.join(base, value))


def resolve_leaf(root: str, value: str) -> str:
    """Resolve a leaf under a canonical root; absolute/~ overrides pass through."""
    value = expand_home(value)
    if os.path.isabs(value):
        return os.path.normpath(value)
    return os.path.normpath(os.path.join(root, value))


def read_block(path: str | None, section: str) -> dict[str, str]:
    """Read the flat indented scalars under ``section:``.

    Comment-stripped, empty values dropped, unrecognized line shapes ignored.
    Stops at the first non-indented content line after the header (or EOF).
    A missing/unreadable path yields an empty mapping.
    """
    out: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return out
    header = re.compile(rf"^{re.escape(section)}:\s*(?:#.*)?$")
    in_block = False
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not in_block:
                if header.match(line):
                    in_block = True
                continue
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line[0].isspace():
                break
            m = _KEY_RE.match(line)
            if not m:
                continue
            value = re.sub(r"\s+#.*$", "", m.group(2)).strip()
            if value == "":
                continue
            out[m.group(1)] = value
    return out


def coerce(value: str) -> Any:
    """Coerce a raw scalar: matched quote pair, then bool, int, float, else str."""
    value = value.strip()
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[1:-1]
    low = value.lower()
    if low in ("true", "false"):
        return low == "true"
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)
    return value


def read_section(
    path: str | None,
    section: str,
    defaults: dict[str, Any],
) -> dict[str, Any]:
    """Overlay the coerced ``section`` block onto ``defaults``.

    Only keys present in ``defaults`` are overlaid, matching the previous
    readers' "known keys" behavior. A missing/unreadable path yields a copy of
    ``defaults``.
    """
    block = read_block(path, section)
    cfg = dict(defaults)
    for key in defaults:
        if key in block:
            cfg[key] = coerce(block[key])
    return cfg
