#!/usr/bin/env python3
"""Stateless CLI bridge for the decision provider (plan section 5).

Reads ONE JSON decision request on stdin, writes ONE JSON result on stdout.
This is the exact contract ``.opencode/plugin/lib/decisions.ts`` will call:

    python3 .opencode/scripts/decisions_bridge.py --config <sysop-config.yaml> \\
        --backend llamacpp

The real logic lives in ``openjevserver.py``; this file only fixes the
invocation shape (no server, no port) so the TS side stays backend-agnostic.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from openjevserver import main as _openjev_main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(_openjev_main(["--oneshot", *sys.argv[1:]]))
