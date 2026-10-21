#!/usr/bin/env python3
"""Tests for the hosted Clef decision backend (``backend: clef-openrouter``).

OpenRouter serves Clef through ``POST /api/alpha/decisions`` with the same
``{model, state, questions}`` body as Ollama's ``/v1/systemone``. These tests
pin the endpoint normalization, credential resolution, prefix stripping, and
the typed request/response mapping without touching the network.

Run:
    python3 -m unittest scripts.tests.test_clef_openrouter
    python3 scripts/tests/test_clef_openrouter.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, ".opencode", "scripts"))

import openjevserver as o  # noqa: E402


AUTH = {"openrouter": {"type": "api", "key": "sk-or-test"}}
MODELS = {
    "openrouter": {
        "api": "https://openrouter.ai/api/v1",
        "env": ["OPENROUTER_API_KEY"],
    },
}


class ClefOpenRouterTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.auth_file = os.path.join(self._tmp.name, "auth.json")
        self.models_file = os.path.join(self._tmp.name, "models.json")
        self._write_auth(AUTH)
        with open(self.models_file, "w", encoding="utf-8") as fh:
            json.dump(MODELS, fh)
        self.cfg = {
            **o.DEFAULTS,
            "backend": "clef-openrouter",
            "model": "openrouter/cloudflare/clef",
            "auth_file": self.auth_file,
            "models_file": self.models_file,
        }

    def _write_auth(self, data: dict) -> None:
        with open(self.auth_file, "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def test_api_root_normalization(self) -> None:
        for raw in (
            "https://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1/",
            "https://openrouter.ai/api",
        ):
            self.assertEqual(o._openrouter_api_root(raw), "https://openrouter.ai/api")

    def test_backend_resolves_typed_endpoint(self) -> None:
        backend = o.make_backend(self.cfg)
        self.assertIsInstance(backend, o.SystemOneBackend)
        self.assertTrue(backend.supports_systemone)
        self.assertEqual(backend.base_url, "https://openrouter.ai/api")
        self.assertEqual(backend.path, "/alpha/decisions")
        self.assertEqual(backend.model, "cloudflare/clef")
        self.assertEqual(backend.api_key, "sk-or-test")

    def test_bare_model_kept_as_is(self) -> None:
        self.cfg["model"] = "cloudflare/clef-flash"
        backend = o.make_backend(self.cfg)
        self.assertEqual(backend.model, "cloudflare/clef-flash")

    def test_missing_key_abstains(self) -> None:
        self._write_auth({})
        backend = o.make_backend(self.cfg)
        self.assertIsInstance(backend, o.UnavailableBackend)

    def test_noul_posts_typed_contract(self) -> None:
        backend = o.make_backend(self.cfg)
        captured: dict = {}

        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def read(self) -> bytes:
                return json.dumps({
                    "answers": {"q": {"type": "noul", "noul": 0.8}},
                    "usage": {"input_tokens": 11, "output_tokens": 0},
                }).encode()

        def fake_urlopen(req, timeout=0):  # noqa: ANN001
            captured["url"] = req.full_url
            captured["headers"] = {k.lower(): v for k, v in req.header_items()}
            captured["body"] = json.loads(req.data)
            return _Resp()

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            probs, usage = backend.systemone_noul("state text", "assertion")

        self.assertAlmostEqual(probs["true"], 0.8)
        self.assertAlmostEqual(probs["false"], 0.2)
        self.assertEqual(usage["promptTokens"], 11)
        self.assertEqual(captured["url"], "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(captured["headers"]["authorization"], "Bearer sk-or-test")
        self.assertEqual(captured["body"]["model"], "cloudflare/clef")
        self.assertEqual(captured["body"]["state"], "state text")
        self.assertEqual(captured["body"]["questions"]["q"]["type"], "noul")


if __name__ == "__main__":
    unittest.main()
