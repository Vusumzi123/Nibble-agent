#!/usr/bin/env python3
"""Regression tests for the block-scoped config editor used by setup.sh.

The clef selection used to rewrite whichever `provider:` appeared first in the
file. Once the template gained a `memory:` block with a `provider:` key above
`decisions:`, that silently configured memory instead of the decision gate
(Kael, 2026-10-17). These tests pin the editor to the requested block.

Run:
    python3 -m unittest scripts.tests.test_setup_decisions
    python3 scripts/tests/test_setup_decisions.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EXAMPLE = os.path.join(REPO_ROOT, ".opencode", "sysop-config.example.yaml")
HELPER = os.path.join(REPO_ROOT, "scripts", "lib", "config-edit.sh")


def _block(text: str, name: str) -> dict[str, str]:
    """Flat `key: value` pairs of one top-level block (comments stripped)."""
    out: dict[str, str] = {}
    inside = False
    for line in text.splitlines():
        if line and not line[0].isspace():
            inside = line.split(":", 1)[0].strip() == name
            continue
        if not inside or not line.strip() or line.lstrip().startswith("#"):
            continue
        key, _, value = line.strip().partition(":")
        out[key.strip()] = value.split("#", 1)[0].strip()
    return out


def _set(cfg: str, block: str, key: str, value: str, anchor: str = "") -> None:
    script = 'source "$1"; set_block_key "$2" "$3" "$4" "$5" "${6-}"'
    args = ["bash", "-c", script, "_", HELPER, cfg, block, key, value, anchor]
    subprocess.run(args, check=True)


class BlockScopeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.cfg = os.path.join(self._tmp.name, "sysop-config.yaml")
        shutil.copyfile(EXAMPLE, self.cfg)

    def _text(self) -> str:
        with open(self.cfg, encoding="utf-8") as fh:
            return fh.read()

    def test_backend_edits_stay_in_decisions(self) -> None:
        # Mirrors apply_decisions_backend clef clef-flash-2k http://127.0.0.1:11434
        _set(self.cfg, "decisions", "provider", "openjev")
        _set(self.cfg, "decisions", "backend", "clef", "provider")
        _set(self.cfg, "decisions", "model", "clef-flash-2k", "backend")
        _set(self.cfg, "decisions", "base_url", "http://127.0.0.1:11434", "model")

        decisions = _block(self._text(), "decisions")
        self.assertEqual(decisions["provider"], "openjev")
        self.assertEqual(decisions["backend"], "clef")
        self.assertEqual(decisions["model"], "clef-flash-2k")
        self.assertEqual(decisions["base_url"], "http://127.0.0.1:11434")

        memory = _block(self._text(), "memory")
        self.assertEqual(memory, {"provider": "both"})

    def test_rules_reset_leaves_other_keys(self) -> None:
        _set(self.cfg, "decisions", "provider", "openjev")
        _set(self.cfg, "decisions", "model", "clef-flash-2k", "provider")
        _set(self.cfg, "decisions", "provider", "rules")

        decisions = _block(self._text(), "decisions")
        self.assertEqual(decisions["provider"], "rules")
        self.assertEqual(decisions["model"], "clef-flash-2k")
        self.assertEqual(_block(self._text(), "memory"), {"provider": "both"})

    def test_existing_value_keeps_comment(self) -> None:
        _set(self.cfg, "decisions", "provider", "openjev")
        self.assertIn("provider: openjev", self._text())

    def test_missing_block_fails(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError):
            _set(self.cfg, "not-a-block", "provider", "openjev")



if __name__ == "__main__":
    unittest.main()
