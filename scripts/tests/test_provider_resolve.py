#!/usr/bin/env python3
"""Unit tests for the opencode provider resolver in openjevserver.py.

stdlib ``unittest``; no network. Fixture ``auth.json`` / ``models.json`` are
written to a temp dir and passed through the ``auth_file`` / ``models_file``
overrides, so the real opencode state is never touched.

Run:
    python3 -m unittest scripts.tests.test_provider_resolve
    python3 scripts/tests/test_provider_resolve.py
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


AUTH = {
    "deepseek": {"type": "api", "key": "sk-deepseek"},
    "moonshotai": {"type": "api", "key": "sk-moonshot"},
    "oauthprov": {"type": "oauth", "access": "tok"},
}

MODELS = {
    "deepseek": {"api": "https://api.deepseek.com", "env": ["DEEPSEEK_API_KEY"]},
    "moonshotai": {"api": "https://api.moonshot.ai/v1", "env": ["MOONSHOT_API_KEY"]},
    # `api` is an npm package name, not a URL -> no resolvable endpoint.
    "sdkonly": {"env": ["SDKONLY_API_KEY"]},
    "oauthprov": {"api": "https://oauth.example/v1", "env": ["OAUTH_API_KEY"]},
}


class _FixtureMixin:
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.auth_file = os.path.join(self._tmp.name, "auth.json")
        self.models_file = os.path.join(self._tmp.name, "models.json")
        with open(self.auth_file, "w", encoding="utf-8") as fh:
            json.dump(AUTH, fh)
        with open(self.models_file, "w", encoding="utf-8") as fh:
            json.dump(MODELS, fh)
        self.cfg = {
            **o.DEFAULTS,
            "auth_file": self.auth_file,
            "models_file": self.models_file,
            "model": "deepseek/deepseek-flash",
        }


class ResolverTestCase(_FixtureMixin, unittest.TestCase):
    def test_resolves_provider_base_url_and_key(self):
        r = o.resolve_opencode_provider(self.cfg)
        self.assertEqual(r["provider"], "deepseek")
        self.assertEqual(r["base_url"], "https://api.deepseek.com")
        self.assertEqual(r["api_key"], "sk-deepseek")
        self.assertEqual(r["model"], "deepseek-flash")

    def test_model_keeps_interior_slash(self):
        cfg = {**self.cfg, "model": "moonshotai/org/sub/model"}
        r = o.resolve_opencode_provider(cfg)
        self.assertEqual(r["provider"], "moonshotai")
        self.assertEqual(r["model"], "org/sub/model")

    def test_leading_tilde_alias_preserved(self):
        cfg = {**self.cfg, "model": "moonshotai/~vendor/alias"}
        r = o.resolve_opencode_provider(cfg)
        self.assertEqual(r["model"], "~vendor/alias")

    def test_api_provider_override(self):
        cfg = {**self.cfg, "model": "bare-model", "api_provider": "deepseek"}
        r = o.resolve_opencode_provider(cfg)
        self.assertEqual(r["provider"], "deepseek")
        self.assertEqual(r["model"], "bare-model")

    def test_base_url_override_wins(self):
        cfg = {**self.cfg, "base_url": "https://custom.example/v1"}
        r = o.resolve_opencode_provider(cfg)
        self.assertEqual(r["base_url"], "https://custom.example/v1")

    def test_api_key_file_override_wins(self):
        key_file = os.path.join(self._tmp.name, "key")
        with open(key_file, "w", encoding="utf-8") as fh:
            fh.write("sk-from-file\n")
        cfg = {**self.cfg, "api_key_file": key_file}
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-from-env"}):
            r = o.resolve_opencode_provider(cfg)
        self.assertEqual(r["api_key"], "sk-from-file")

    def test_env_key_used_before_auth(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-from-env"}):
            r = o.resolve_opencode_provider(self.cfg)
        self.assertEqual(r["api_key"], "sk-from-env")

    def test_missing_provider_raises(self):
        cfg = {**self.cfg, "model": "nope/model"}
        with self.assertRaises(o.ProviderResolveError):
            o.resolve_opencode_provider(cfg)

    def test_sdk_only_provider_without_base_url_raises(self):
        cfg = {**self.cfg, "model": "sdkonly/model"}
        with self.assertRaises(o.ProviderResolveError):
            o.resolve_opencode_provider(cfg)

    def test_oauth_provider_raises(self):
        cfg = {**self.cfg, "model": "oauthprov/model"}
        with self.assertRaises(o.ProviderResolveError):
            o.resolve_opencode_provider(cfg)

    def test_missing_auth_key_raises(self):
        cfg = {**self.cfg, "model": "ghost/model"}
        with mock.patch.dict(os.environ, {"GHOST_API_KEY": ""}):
            with self.assertRaises(o.ProviderResolveError):
                o.resolve_opencode_provider(cfg)

    def test_default_paths_honor_xdg(self):
        with mock.patch.dict(os.environ, {
            "XDG_DATA_HOME": "/tmp/xdg-data",
            "XDG_CACHE_HOME": "/tmp/xdg-cache",
        }):
            self.assertEqual(o.default_auth_file(), "/tmp/xdg-data/opencode/auth.json")
            self.assertEqual(o.default_models_file(), "/tmp/xdg-cache/opencode/models.json")


class MakeBackendTestCase(_FixtureMixin, unittest.TestCase):
    def test_make_backend_resolves_openai_compat(self):
        cfg = dict(self.cfg)
        b = o.make_backend(cfg)
        self.assertIsInstance(b, o.OpenAICompatBackend)
        self.assertEqual(b.model, "deepseek-flash")
        self.assertEqual(b.base_url, "https://api.deepseek.com")
        self.assertEqual(cfg["backend"], "opencode/deepseek")

    def test_make_backend_llamacpp_explicit(self):
        cfg = {**self.cfg, "backend": "llamacpp", "base_url": "http://127.0.0.1:8090"}
        b = o.make_backend(cfg)
        self.assertIsInstance(b, o.LlamaCppBackend)
        self.assertEqual(cfg["backend"], "llamacpp")

    def test_make_backend_base_url_fallback(self):
        cfg = {**self.cfg, "model": "nope/model", "base_url": "http://127.0.0.1:9999"}
        b = o.make_backend(cfg)
        self.assertIsInstance(b, o.LlamaCppBackend)

    def test_make_backend_unavailable_abstains(self):
        cfg = {**self.cfg, "model": "nope/model"}
        b = o.make_backend(cfg)
        self.assertIsInstance(b, o.UnavailableBackend)
        out = o.safe_dispatch(b, cfg, {"kind": "noul", "state": "x", "assertion": "y"})
        self.assertTrue(out["abstained"])
        self.assertIn("no base URL", out["error"])


if __name__ == "__main__":
    unittest.main()
