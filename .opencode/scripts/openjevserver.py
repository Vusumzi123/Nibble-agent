#!/usr/bin/env python3
"""OpenJev decision backend — a self-contained stand-in for the OpenJevPro
typed-decision API.

Two transports are available for the same per-decision candidate log-probs:

* a running **llama.cpp** server (``backend: llamacpp``), and
* any **OpenAI-compatible hosted provider** the user already configured in
  opencode — the endpoint + credential are resolved from opencode's own
  ``models.json`` / ``auth.json`` from an opencode ``<provider>/<model>`` spec
  (see :func:`resolve_opencode_provider` and
  ``docs/openjev-opencode-provider-plan.md``).

The llama.cpp path implements the three Jev decision primitives
(choice / noul / score) on top of llama.cpp's *native* ``POST /completion``
endpoint (plan "Route B"):

    request  -> prompt -> n_predict=1, n_probs>0, completion_probabilities=true
    response -> completion_probabilities[0].top_logprobs
             -> keep the candidate tokens (A/B, TRUE/FALSE, 1..5, ...)
             -> temperature-scale the candidate log-probs into a softmax
             -> value = argmax, confidence = max probability

Stdlib only (urllib + http.server); no third-party deps, no daemon required.
See ``docs/jev-decision-provider-plan.md`` for the design this prototypes.

Modes
-----
  serve      (default)  start an HTTP server on 127.0.0.1:8091
  --oneshot             read ONE JSON request on stdin, write ONE JSON result
  --request '<json>'    run one request from the command line
  --selftest            run built-in cases against the live upstream

Run ``openjevserver.py --help`` for all flags.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sysop_config import coerce, read_block  # noqa: E402

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "mode": "shadow",              # shadow | gate
    "provider": "openjev",         # openjev | jev-hosted | rules
    "backend": "",                 # "" = auto opencode provider; "llamacpp" = local
    "transport": "chat",           # chat | completion (see LlamaCppBackend)
    "base_url": "",                # override: pin an endpoint (no /v1 suffix)
    "api_provider": "",            # override: provider id when `model` has no prefix
    "model": "deepseek/deepseek-chat",   # opencode spec: <provider>/<model>
    "api_key_file": "",            # override: chmod-600 key file
    "auth_file": "",               # override: path to opencode auth.json
    "models_file": "",             # override: path to opencode models.json
    "temperature_scaling": 1.00,   # self-reported confidence is uncalibrated -> 1.0
    "abstain_threshold": 0.45,
    "noul_threshold": 0.80,
    "timeout_ms": 30000,
    "fallback": "rules",
    "n_probs": 20,
}

# Native llama.cpp endpoint used when `backend: llamacpp` (or a base_url override)
# is selected without an explicit URL.
DEFAULT_LLAMACPP_URL = "http://127.0.0.1:8090"

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_CONFIG = os.path.join(REPO_ROOT, ".opencode", "sysop-config.yaml")


# --------------------------------------------------------------------------- #
# Config                                                                       #
# --------------------------------------------------------------------------- #
def load_config(path: str | None) -> dict[str, Any]:
    """Read the ``decisions:`` block of sysop-config.yaml via the shared reader.

    Deliberately dependency-free: ``sysop_config`` scans the flat indented
    scalars. Keys present in the block override DEFAULTS; unknown keys are kept,
    matching the previous hand-rolled reader.
    """
    cfg = dict(DEFAULTS)
    for key, value in read_block(path, "decisions").items():
        cfg[key] = coerce(value)
    return cfg


# --------------------------------------------------------------------------- #
# llama.cpp backend                                                            #
#                                                                              #
# Two transports for the same per-token top_logprobs:                          #
#                                                                              #
#   chat (default)  POST /v1/chat/completions with logprobs +                  #
#                   chat_template_kwargs.enable_thinking=false, read           #
#                   choices[0].logprobs.content[0].top_logprobs.                #
#                   REQUIRED for reasoning models like Bonsai: without the     #
#                   template the first token is <|im_end|>/whitespace and the  #
#                   real candidates never surface.                             #
#                                                                              #
#   completion      POST /completion with n_predict/n_probs/                   #
#                   completion_probabilities (the plan's "Route B"), read      #
#                   completion_probabilities[0].top_logprobs. Kept as a        #
#                   fallback for non-chat servers; unreliable on Bonsai.       #
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = ("You are a deterministic decision engine. Answer with exactly "
                 "one token. Never explain, never think, never add punctuation.")

# The exact noul assertion the knowledge-hook skip-triage asks (kept identical to
# TRIAGE_ASSERTION in .opencode/plugin/lib/decisions.ts and reused by the selftest
# and the corpus replay so the prompt can never drift between them).
TRIAGE_ASSERTION = ("The transcript is pure filler with no durable signal, "
                    "decision, config, command, or question.")


class LlamaCppBackend:
    def __init__(self, base_url: str, timeout_ms: int, n_probs: int,
                 transport: str = "chat"):
        self.base_url = base_url.rstrip("/")
        self.timeout = max(1.0, timeout_ms / 1000.0)
        self.n_probs = n_probs
        self.transport = transport if transport in ("chat", "completion") else "chat"

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path, data=data,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _get(self, path: str) -> dict[str, Any]:
        with urllib.request.urlopen(self.base_url + path, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _chat(self, prompt: str) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
        body = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 1,
            "temperature": 0.0,
            "logprobs": True,
            "top_logprobs": self.n_probs,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            resp = self._post("/v1/chat/completions", body)
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
            body.pop("chat_template_kwargs", None)
            resp = self._post("/v1/chat/completions", body)
        ch = resp["choices"][0]
        content = (ch.get("logprobs") or {}).get("content") or []
        top = content[0].get("top_logprobs", []) if content else []
        return top, ch.get("message", {}).get("content") or "", normalize_usage(resp, "chat")

    def _completion(self, prompt: str) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
        body = {
            "prompt": prompt,
            "n_predict": 1,
            "temperature": 0.0,
            "n_probs": self.n_probs,
            "completion_probabilities": True,
        }
        resp = self._post("/completion", body)
        cp = resp.get("completion_probabilities") or []
        top = cp[0].get("top_logprobs", []) if cp else []
        return top, resp.get("content", "") or "", normalize_usage(resp, "completion")

    def top_logprobs(self, prompt: str) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
        if self.transport == "completion":
            return self._completion(prompt)
        return self._chat(prompt)

    def health(self) -> dict[str, Any]:
        try:
            props = self._get("/props")
            return {
                "status": "ok",
                "model": props.get("model_alias") or props.get("model_path"),
                "n_ctx": props.get("n_ctx"),
                "slots": props.get("total_slots"),
                "transport": self.transport,
            }
        except Exception as exc:  # noqa: BLE001 - surface any transport failure
            return {"status": "unreachable", "error": str(exc)}


def _read_api_key(path: str) -> str:
    """Read a bearer key from a chmod-600 file (never inline)."""
    if not path:
        raise RuntimeError("api_key_file is empty")
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        raise RuntimeError(f"api key file not found: {p}")
    with open(p, "r", encoding="utf-8") as fh:
        key = fh.read().strip()
    if not key:
        raise RuntimeError(f"empty api key file: {p}")
    return key


def _json_instruction(labels: list[str]) -> str:
    opts = ", ".join(json.dumps(l) for l in labels)
    return ("Respond with a single JSON object and nothing else, with exactly two "
            f"keys: \"answer\" (one of: {opts}) and \"confidence\" (a number 0 to 1).")


def _parse_structured(content: str, labels: list[str]) -> list[dict[str, Any]]:
    """Parse a JSON-mode structured reply into synthetic candidate log-probs.

    The reported confidence is a probability (not a log-prob), so each candidate
    is assigned ``log(prob)`` and the unchanged ``calibrate`` softmax reproduces
    the probability exactly when ``temperature_scaling`` is 1.0. Raises on any
    malformed / off-label reply so ``safe_dispatch`` fail-opens to rules.
    """
    text = (content or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"structured output is not JSON: {text[:200]!r}")
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError as exc:
        raise ValueError(f"structured JSON parse failed: {exc}") from exc
    answer = str(obj.get("answer", "")).strip()
    try:
        conf = float(obj.get("confidence"))
    except (TypeError, ValueError):
        raise ValueError(f"missing numeric confidence: {obj!r}") from None
    conf = min(0.99, max(0.01, conf))
    norm = {l.strip().upper(): l for l in labels}
    if answer.upper() not in norm:
        raise ValueError(f"model answer {answer!r} not in {labels}")
    n = len(labels)
    return [
        {"token": l,
         "logprob": math.log(conf if l == norm[answer.upper()] else (1.0 - conf) / (n - 1) if n > 1 else 0.0)}
        for l in labels
    ]


# --------------------------------------------------------------------------- #
# opencode provider resolution                                                 #
#                                                                              #
# The decision backend reuses a provider the user already configured in        #
# opencode instead of a parallel base_url/api_key_file registry. `model` is an #
# opencode spec `<provider>/<model>`; the endpoint and credential are resolved #
# from opencode's own files. Any failure raises ProviderResolveError so the    #
# caller can abstain (fail-open -> rules).                                     #
# See docs/openjev-opencode-provider-plan.md §5.                               #
# --------------------------------------------------------------------------- #
class ProviderResolveError(RuntimeError):
    """Endpoint or credential for an opencode provider could not be resolved."""


def _xdg_data_home() -> str:
    return os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share")


def _xdg_cache_home() -> str:
    return os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache")


def default_auth_file() -> str:
    return os.path.join(_xdg_data_home(), "opencode", "auth.json")


def default_models_file() -> str:
    return os.path.join(_xdg_cache_home(), "opencode", "models.json")


def _load_json(path: str) -> Any:
    """Best-effort JSON read. Missing/unreadable/malformed -> None."""
    if not path:
        return None
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def resolve_provider_id(cfg: dict[str, Any]) -> str:
    """Provider id: explicit ``api_provider`` override, else the model prefix."""
    explicit = str(cfg.get("api_provider") or "").strip()
    if explicit:
        return explicit
    model = str(cfg.get("model") or "").strip()
    if "/" in model:
        return model.split("/", 1)[0].strip()
    return ""


def resolve_model_id(cfg: dict[str, Any], provider_id: str) -> str:
    """The bare model id: strip the ``<provider>/`` prefix, keep interior slashes."""
    model = str(cfg.get("model") or "").strip()
    if not model:
        return ""
    if provider_id and model.startswith(provider_id + "/"):
        return model[len(provider_id) + 1:]
    if "/" in model:
        return model.split("/", 1)[1]
    return model


def _catalog_entry(cfg: dict[str, Any], provider_id: str) -> dict[str, Any]:
    models_file = str(cfg.get("models_file") or "").strip() or default_models_file()
    data = _load_json(models_file)
    if isinstance(data, dict):
        entry = data.get(provider_id)
        if isinstance(entry, dict):
            return entry
    return {}


def resolve_base_url(cfg: dict[str, Any], provider_id: str) -> str:
    """Base URL: ``base_url`` override -> models.json ``api`` -> opencode.json."""
    override = str(cfg.get("base_url") or "").strip()
    if override:
        return override.rstrip("/")
    api = _catalog_entry(cfg, provider_id).get("api")
    if isinstance(api, str) and api.startswith(("http://", "https://")):
        return api.rstrip("/")
    oc = _load_json(os.path.join(REPO_ROOT, "opencode.json"))
    if isinstance(oc, dict):
        try:
            burl = oc["provider"][provider_id]["options"]["baseURL"]
        except (TypeError, KeyError):
            burl = None
        if isinstance(burl, str) and burl.startswith(("http://", "https://")):
            return burl.rstrip("/")
    raise ProviderResolveError(
        f"no base URL for provider {provider_id!r} "
        "(set base_url or add it to models.json / opencode.json)")


def resolve_api_key(cfg: dict[str, Any], provider_id: str) -> str:
    """API key: ``api_key_file`` -> catalog env var -> opencode auth.json."""
    key_file = str(cfg.get("api_key_file") or "").strip()
    if key_file:
        try:
            return _read_api_key(key_file)
        except RuntimeError as exc:
            raise ProviderResolveError(str(exc)) from exc
    for name in _catalog_entry(cfg, provider_id).get("env") or []:
        if isinstance(name, str) and os.environ.get(name):
            return os.environ[name]
    auth_file = str(cfg.get("auth_file") or "").strip() or default_auth_file()
    auth = _load_json(auth_file)
    if isinstance(auth, dict):
        provider_entry = auth.get(provider_id)
        if provider_entry is None and isinstance(auth.get("providers"), dict):
            provider_entry = auth["providers"].get(provider_id)
        if isinstance(provider_entry, dict):
            if str(provider_entry.get("type", "")).lower() == "oauth":
                raise ProviderResolveError(
                    f"provider {provider_id!r} uses oauth; set base_url + api_key_file")
            key = provider_entry.get("key")
            if isinstance(key, str) and key.strip():
                return key.strip()
    raise ProviderResolveError(
        f"no API key for provider {provider_id!r} "
        "(set api_key_file, export its env var, or run `opencode auth login`)")


def resolve_opencode_provider(cfg: dict[str, Any]) -> dict[str, str]:
    """Resolve ``{provider, base_url, api_key, model}`` from opencode's config.

    Raises ProviderResolveError on any missing endpoint/credential so the caller
    can abstain (the bridge then fail-opens to the rules provider).
    """
    provider_id = resolve_provider_id(cfg)
    return {
        "provider": provider_id,
        "base_url": resolve_base_url(cfg, provider_id),
        "api_key": resolve_api_key(cfg, provider_id),
        "model": resolve_model_id(cfg, provider_id),
    }


class OpenAICompatBackend:
    """OpenAI-compatible hosted backend (DeepSeek, Moonshot, OpenRouter, …).

    Endpoint + credential are resolved from opencode (see the resolver above) and
    passed in explicitly. ``logprobs`` is not usable here — at ``temperature 0``
    it is degenerate (the greedy token carries all mass and every alternative is
    the ``-9999`` sentinel) — so this backend uses JSON mode
    (``response_format=json_object``, falling back to loose JSON on HTTP 400)
    plus a self-reported confidence, synthesizing candidate log-probs from the
    reported probability. Confidence is therefore **uncalibrated**;
    ``temperature_scaling`` must stay 1.0.

    Same surface as ``LlamaCppBackend`` so the decision functions are unchanged;
    ``supports_logprobs`` routes them to ``structured_top_logprobs``.
    """
    supports_logprobs = False

    def __init__(self, base_url: str, api_key: str, model: str,
                 timeout_ms: int = 30000, n_probs: int = 20):
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.timeout = max(1.0, float(timeout_ms) / 1000.0)
        self.n_probs = n_probs
        self._api_key: str = api_key

    def _key(self) -> str:
        if not self._api_key:
            raise RuntimeError("no API key resolved for OpenAI-compatible backend")
        return self._api_key

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(
            self.base_url + path, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + self._key()},
            method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def structured_top_logprobs(self, prompt: str,
                                labels: list[str]) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt + "\n" + _json_instruction(labels)},
            ],
            "temperature": 0.0,
            "max_tokens": 64,
            "response_format": {"type": "json_object"},
        }
        try:
            resp = self._post("/chat/completions", body)
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
            body.pop("response_format", None)  # JSON mode unsupported -> retry loose
            resp = self._post("/chat/completions", body)
        content = resp["choices"][0].get("message", {}).get("content", "") or ""
        top = _parse_structured(content, labels)
        return top, content, normalize_usage(resp, "chat")

    def top_logprobs(self, prompt: str) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
        raise NotImplementedError("OpenAICompatBackend uses structured_top_logprobs")

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "backend": "openai-compat", "model": self.model,
                "base_url": self.base_url, "capability": "structured-json"}


def _probe(backend: Any, prompt: str, labels: list[str]) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
    """Return ``(top, content, usage)`` for a decision, via log-probs or the
    structured JSON path depending on the backend's capability."""
    if getattr(backend, "supports_logprobs", True):
        return backend.top_logprobs(prompt)
    return backend.structured_top_logprobs(prompt, labels)


def _make_llamacpp(cfg: dict[str, Any], base_url: str) -> LlamaCppBackend:
    cfg["backend"] = "llamacpp"
    return LlamaCppBackend(base_url, cfg.get("timeout_ms", 30000),
                           cfg.get("n_probs", 20), cfg.get("transport", "chat"))


class UnavailableBackend:
    """Placeholder backend whose every probe raises, so safe_dispatch abstains.

    Used when an opencode provider cannot be resolved and no ``base_url``
    override is set: the bridge returns an abstained result and the rules
    fallback applies (fail-open).
    """
    supports_logprobs = False

    def __init__(self, error: str):
        self.error = error
        self.base_url = ""
        self.model = ""
        self.transport = "chat"

    def structured_top_logprobs(self, *_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(self.error)

    def top_logprobs(self, *_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(self.error)

    def health(self) -> dict[str, Any]:
        return {"status": "unavailable", "error": self.error}


def make_backend(cfg: dict[str, Any]) -> Any:
    """Instantiate the decision backend from ``cfg``.

    - ``backend: llamacpp`` -> the native llama.cpp backend.
    - otherwise resolve an opencode provider (endpoint + credential) and build an
      ``OpenAICompatBackend``.
    - on resolution failure: a set ``base_url`` falls back to the llama.cpp path,
      else an ``UnavailableBackend`` (abstain -> rules).
    """
    backend = str(cfg.get("backend") or "").strip().lower()
    base_url = str(cfg.get("base_url") or "").strip()
    if backend == "llamacpp":
        return _make_llamacpp(cfg, base_url or DEFAULT_LLAMACPP_URL)
    try:
        resolved = resolve_opencode_provider(cfg)
    except ProviderResolveError as exc:
        if base_url:
            return _make_llamacpp(cfg, base_url)
        return UnavailableBackend(str(exc))
    label = f"opencode/{resolved['provider']}" if resolved["provider"] else "openai-compat"
    cfg["backend"] = label
    cfg["model"] = resolved["model"] or resolved["provider"]
    return OpenAICompatBackend(
        resolved["base_url"], resolved["api_key"], resolved["model"],
        timeout_ms=cfg.get("timeout_ms", 30000), n_probs=cfg.get("n_probs", 20),
    )


# --------------------------------------------------------------------------- #
# Decision math                                                                #
# --------------------------------------------------------------------------- #
def _logsumexp(values: list[float]) -> float:
    m = max(values)
    return m + math.log(sum(math.exp(v - m) for v in values))


def candidate_logprobs(top: list[dict[str, Any]], candidates: list[str]) -> dict[str, float]:
    """Aggregate top_logprobs onto normalized candidate tokens.

    Matching is case-insensitive and whitespace-insensitive, so ``" A"``,
    ``"A"``, ``" true"`` and ``"TRUE"`` all map onto their candidate. Multiple
    surface forms for one candidate are combined with logsumexp. Candidates
    absent from the top list get a floor log-prob so a decision is still made
    (and marked low-evidence), keeping the engine fail-open.
    """
    keys = {c.strip().upper(): c for c in candidates}
    buckets: dict[str, list[float]] = {c: [] for c in candidates}
    for entry in top:
        token = str(entry.get("token", "")).strip().upper()
        if token in keys:
            buckets[keys[token]].append(float(entry.get("logprob", -100.0)))
    seen = [float(e.get("logprob", -100.0)) for e in top]
    floor = (min(seen) if seen else -20.0) - 6.0
    return {c: (_logsumexp(v) if v else floor) for c, v in buckets.items()}


def calibrate(logprobs: list[float], temperature: float) -> list[float]:
    """Softmax with fixed temperature scaling (OpenJevPro TemperatureCalibrator)."""
    t = max(float(temperature), 1e-6)
    scaled = [v / t for v in logprobs]
    m = max(scaled)
    exps = [math.exp(v - m) for v in scaled]
    total = sum(exps)
    return [e / total for e in exps]


def normalize_usage(resp: dict[str, Any], transport: str) -> dict[str, Any]:
    """Normalize a backend response's token/timing counters into one
    backend-agnostic ``usage`` object.

    The OpenAI-compatible ``/v1/chat/completions`` shape (llama.cpp *and* the
    future DeepSeek / hosted-Jev HTTP backends) reports ``usage.{prompt_tokens,
    completion_tokens, total_tokens}`` and ``timings.{prompt_ms, predicted_ms}``,
    so reading ``usage`` first makes those tiers drop in unchanged. The native
    ``/completion`` transport reports ``tokens_evaluated``/``tokens_predicted``
    plus ``timings`` instead. Returns ``{"usageKnown": False}`` when the backend
    exposes nothing usable.
    """
    usage = resp.get("usage") or {}
    timings = resp.get("timings") or {}
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    if prompt_tokens is None and transport == "completion":
        prompt_tokens = resp.get("tokens_evaluated")
        completion_tokens = resp.get("tokens_predicted")
    if prompt_tokens is None and completion_tokens is None:
        return {"usageKnown": False}
    prompt_tokens = int(prompt_tokens or 0)
    completion_tokens = int(completion_tokens or 0)
    out: dict[str, Any] = {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": prompt_tokens + completion_tokens,
        "usageKnown": True,
    }
    prompt_ms = timings.get("prompt_ms")
    if isinstance(prompt_ms, (int, float)):
        out["promptMs"] = round(float(prompt_ms), 3)
        if prompt_ms > 0 and prompt_tokens > 0:
            out["promptTokensPerSecond"] = round(prompt_tokens / (prompt_ms / 1000.0), 3)
    return out


# --------------------------------------------------------------------------- #
# Prompt builders                                                              #
# --------------------------------------------------------------------------- #
def _as_text(state: Any) -> str:
    if isinstance(state, str):
        return state
    return json.dumps(state, ensure_ascii=False, separators=(",", ":"))


def build_choice_prompt(state: Any, candidates: list[str], criteria: str | None,
                        instructions: str | None = None) -> str:
    out = ["You are a deterministic decision engine. Choose exactly one option."]
    if instructions:
        out += ["Question:", str(instructions)]
    out += ["State:", _as_text(state), ""]
    for i, cand in enumerate(candidates):
        out.append(f"{chr(65 + i)}) {cand}")
    if criteria:
        out += ["", f"Criteria: {criteria}"]
    out += ["", "Reply with only the single option letter.", "Answer:"]
    return "\n".join(out)


def build_noul_prompt(state: Any, assertion: str,
                      instructions: str | None = None) -> str:
    return "\n".join([
        "Decide whether the assertion is TRUE or FALSE given the state.",
        "Assertion:", str(assertion or instructions or ""), "",
        "State:", _as_text(state), "",
        "Reply with only one word: TRUE or FALSE.", "Answer:",
    ])


def build_score_prompt(state: Any, levels: list[str], criteria: str | None,
                       instructions: str | None = None) -> str:
    out = ["Rate the state on this ordered scale."]
    if instructions:
        out += ["Question:", str(instructions)]
    out += ["State:", _as_text(state), "",
            "Scale: " + "; ".join(f"{i + 1} = {lvl}" for i, lvl in enumerate(levels))]
    if criteria:
        out += ["", f"Criteria: {criteria}"]
    out += ["", "Reply with only the level number.", "Answer:"]
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Decision providers                                                           #
# --------------------------------------------------------------------------- #
def _result(kind: str, value: Any, confidence: float, probs: dict[str, float],
            abstained: bool, cfg: dict[str, Any], started: float, top: list[dict],
            label_map: dict[str, str] | None = None, error: str | None = None,
            extra: dict[str, Any] | None = None,
            usage: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {
        "kind": kind,
        "value": value,
        "confidence": round(confidence, 6),
        "probabilities": {k: round(v, 6) for k, v in probs.items()},
        "abstained": abstained,
        "provider": cfg.get("provider", "openjev"),
        "backend": cfg.get("backend", "llamacpp"),
        "model": cfg.get("model"),
        "latencyMs": int((time.monotonic() - started) * 1000),
    }
    if usage:
        out["usage"] = usage
    if label_map:
        out["labelMap"] = label_map
    if error:
        out["error"] = error
    if extra:
        out.update(extra)
    out["evidence"] = [
        {"token": t.get("token"), "logprob": round(float(t.get("logprob", 0)), 4)}
        for t in top
    ]
    return out


def decide_choice(backend: LlamaCppBackend, cfg: dict[str, Any], state: Any,
                  candidates: list[str], criteria: str | None = None,
                  allow_abstain: bool = True,
                  raw_prompt: str | None = None,
                  instructions: str | None = None) -> dict[str, Any]:
    started = time.monotonic()
    candidates = candidates or ["A", "B"]
    labels = [chr(65 + i) for i in range(len(candidates))]
    label_map = dict(zip(labels, candidates))
    prompt = raw_prompt or build_choice_prompt(state, candidates, criteria, instructions)
    top, _, usage = _probe(backend, prompt, labels)
    agg = candidate_logprobs(top, labels)
    probs = calibrate([agg[l] for l in labels], cfg["temperature_scaling"])
    prob_map = {label_map[l]: p for l, p in zip(labels, probs)}
    value = max(prob_map, key=prob_map.get)
    conf = prob_map[value]
    abstained = bool(allow_abstain and conf < cfg["abstain_threshold"])
    return _result("choice", value, conf, prob_map, abstained, cfg, started, top,
                   label_map=label_map, usage=usage)


def decide_noul(backend: LlamaCppBackend, cfg: dict[str, Any], state: Any,
                assertion: str, allow_abstain: bool = False,
                raw_prompt: str | None = None,
                instructions: str | None = None) -> dict[str, Any]:
    started = time.monotonic()
    prompt = raw_prompt or build_noul_prompt(state, assertion, instructions)
    top, _, usage = _probe(backend, prompt, ["TRUE", "FALSE"])
    agg = candidate_logprobs(top, ["TRUE", "FALSE"])
    probs = calibrate([agg["TRUE"], agg["FALSE"]], cfg["temperature_scaling"])
    p_true = probs[0]
    value = p_true >= 0.5
    conf = max(probs)
    # Noul cannot abstain upstream; gate is a separate, explicit threshold.
    abstained = bool(allow_abstain and conf < cfg["abstain_threshold"])
    gate = bool(value and p_true >= cfg["noul_threshold"])
    return _result("noul", value, conf, {"true": p_true, "false": probs[1]},
                   abstained, cfg, started, top,
                   extra={"probabilityTrue": round(p_true, 6), "gate": gate},
                   usage=usage)


def decide_score(backend: LlamaCppBackend, cfg: dict[str, Any], state: Any,
                 criteria: str | None = None, levels: list[str] | None = None,
                 allow_abstain: bool = True,
                 raw_prompt: str | None = None,
                 instructions: str | None = None) -> dict[str, Any]:
    started = time.monotonic()
    labels = [str(l) for l in (levels or ["1", "2", "3", "4", "5"])]
    tokens = [str(i + 1) for i in range(len(labels))]
    label_map = dict(zip(tokens, labels))
    prompt = raw_prompt or build_score_prompt(state, labels, criteria, instructions)
    top, _, usage = _probe(backend, prompt, tokens)
    agg = candidate_logprobs(top, tokens)
    probs = calibrate([agg[t] for t in tokens], cfg["temperature_scaling"])
    prob_map = {label_map[t]: p for t, p in zip(tokens, probs)}
    value = max(prob_map, key=prob_map.get)
    conf = prob_map[value]
    ordinal = sum((i + 1) * p for i, p in enumerate(probs))
    extra: dict[str, Any] = {"expectedOrdinal": round(ordinal, 6)}
    try:
        extra["expectedValue"] = round(sum(float(l) * p for l, p in zip(labels, probs)), 6)
    except ValueError:
        pass
    abstained = bool(allow_abstain and conf < cfg["abstain_threshold"])
    return _result("score", value, conf, prob_map, abstained, cfg, started, top,
                   label_map=label_map if labels != tokens else None, extra=extra,
                   usage=usage)


def _choice_from_criteria(criteria: Any) -> tuple[list[str], str | None]:
    """Normalize a Jev-style choice ``criteria`` into (candidates, criteria text).

    A dict maps option -> description (keys become candidates), a list is taken
    as the candidate set, anything else is passed through as free-text criteria.
    """
    if isinstance(criteria, dict):
        candidates = [str(k) for k in criteria.keys()]
        text = "; ".join(f"{k}: {v}" for k, v in criteria.items())
        return candidates, text
    if isinstance(criteria, list):
        return [str(c) for c in criteria], None
    return [], criteria


def decide_questions(backend: LlamaCppBackend, cfg: dict[str, Any],
                     req: dict[str, Any]) -> dict[str, Any]:
    """Jev-style multi-question request: ``{state, questions: {name: {...}}}``.

    Each question is normalized into a flat sub-request and dispatched
    independently, so one bad/unsupported question cannot fail the batch.
    """
    started = time.monotonic()
    state = req.get("state", "")
    questions = req.get("questions") or {}
    results: dict[str, Any] = {}
    for name, q in questions.items():
        q = q if isinstance(q, dict) else {}
        qtype = q.get("type", "choice")
        instructions = q.get("instructions")
        criteria = q.get("criteria")
        if qtype == "choice":
            candidates, crit_text = _choice_from_criteria(criteria)
            sub = {
                "kind": "choice", "state": state,
                "candidates": candidates or ["A", "B"],
                "criteria": crit_text, "instructions": instructions,
                "allow_abstain": q.get("allow_abstain", True),
            }
        elif qtype == "score":
            levels = criteria if isinstance(criteria, list) else q.get("levels")
            sub = {
                "kind": "score", "state": state, "levels": levels,
                "criteria": None if isinstance(criteria, list) else criteria,
                "instructions": instructions,
                "allow_abstain": q.get("allow_abstain", True),
            }
        elif qtype == "noul":
            sub = {
                "kind": "noul", "state": state,
                "assertion": q.get("assertion") or instructions,
                "allow_abstain": q.get("allow_abstain", False),
            }
        else:
            results[name] = {"kind": str(qtype), "error": f"unknown type: {qtype!r}",
                             "abstained": True}
            continue
        results[name] = safe_dispatch(backend, cfg, sub)
    return {
        "kind": "questions",
        "provider": cfg.get("provider", "openjev"),
        "backend": cfg.get("backend", "llamacpp"),
        "latencyMs": int((time.monotonic() - started) * 1000),
        "results": results,
    }


def dispatch(backend: LlamaCppBackend, cfg: dict[str, Any], req: dict[str, Any]) -> dict[str, Any]:
    if "questions" in req:
        return decide_questions(backend, cfg, req)
    kind = req.get("kind", "choice")
    if kind == "choice":
        return decide_choice(backend, cfg, req.get("state", ""),
                             req.get("candidates") or ["A", "B"],
                             req.get("criteria"),
                             req.get("allow_abstain", True),
                             req.get("prompt"),
                             req.get("instructions"))
    if kind == "noul":
        return decide_noul(backend, cfg, req.get("state", ""),
                           req.get("assertion", ""),
                           req.get("allow_abstain", False),
                           req.get("prompt"),
                           req.get("instructions"))
    if kind == "score":
        return decide_score(backend, cfg, req.get("state", ""),
                            req.get("criteria"), req.get("levels"),
                            req.get("allow_abstain", True),
                            req.get("prompt"),
                            req.get("instructions"))
    return {"error": f"unknown kind: {kind!r}", "abstained": True,
            "fallback": cfg.get("fallback", "rules")}


def safe_dispatch(backend: LlamaCppBackend, cfg: dict[str, Any],
                  req: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        return dispatch(backend, cfg, req)
    except Exception as exc:  # noqa: BLE001 - fail-open is a hard requirement
        return {
            "kind": req.get("kind") or ("questions" if "questions" in req else "choice"),
            "value": None,
            "confidence": 0.0,
            "probabilities": {},
            "abstained": True,
            "provider": cfg.get("provider", "openjev"),
            "backend": cfg.get("backend", "llamacpp"),
            "model": cfg.get("model"),
            "latencyMs": int((time.monotonic() - started) * 1000),
            "error": f"{type(exc).__name__}: {exc}",
            "fallback": cfg.get("fallback", "rules"),
        }


# --------------------------------------------------------------------------- #
# HTTP server                                                                  #
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    backend: LlamaCppBackend
    cfg: dict[str, Any]
    server_version = "openjevserver/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, obj: Any) -> None:
        payload = json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/health", "/healthz"):
            health = self.backend.health()
            self._send(200 if health.get("status") == "ok" else 503, {
                "service": "openjevserver",
                "config": {"provider": self.cfg.get("provider"),
                           "backend": self.cfg.get("backend"),
                           "mode": self.cfg.get("mode")},
                "upstream": self.backend.base_url,
                **health,
            })
        elif self.path == "/v1/models":
            self._send(200, {"models": [{"id": self.cfg.get("model"),
                                         "object": "model",
                                         "owned_by": "openjevserver"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._read_json()
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": f"invalid JSON: {exc}"})
            return
        if self.path in ("/decide", "/v1/decide", "/v1/systemone"):
            self._send(200, safe_dispatch(self.backend, self.cfg, body))
        elif self.path == "/v1/decide/choice":
            body["kind"] = "choice"
            self._send(200, safe_dispatch(self.backend, self.cfg, body))
        elif self.path == "/v1/decide/noul":
            body["kind"] = "noul"
            self._send(200, safe_dispatch(self.backend, self.cfg, body))
        elif self.path == "/v1/decide/score":
            body["kind"] = "score"
            self._send(200, safe_dispatch(self.backend, self.cfg, body))
        else:
            self._send(404, {"error": "not found"})


def serve(backend: LlamaCppBackend, cfg: dict[str, Any], host: str, port: int) -> int:
    handler = type("BoundHandler", (Handler,), {"backend": backend, "cfg": cfg})
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"openjevserver listening on http://{host}:{port}", file=sys.stderr)
    print(f"upstream {backend.base_url}  backend={cfg.get('backend')}  "
          f"transport={cfg.get('transport')}  model={cfg.get('model')}  mode={cfg.get('mode')}",
          file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", file=sys.stderr)
    finally:
        httpd.server_close()
    return 0


# --------------------------------------------------------------------------- #
# Self-test                                                                    #
# --------------------------------------------------------------------------- #
TRIVIAL = "user: hi\nassistant: hi there\nuser: how are you?\nassistant: good thanks!"
DURABLE = ("user: my audiobook narration pipeline needs re-encoding to mono 44.1k\n"
           "assistant: use ffmpeg -ac 1 -ar 44100; the config lives in ~/.config/narration.toml")

SELFTEST_CASES: list[dict[str, Any]] = [
    {"kind": "noul", "name": "trivial chatter -> skip",
     "assertion": TRIAGE_ASSERTION,
     "state": TRIVIAL, "expect_true": True},
    {"kind": "noul", "name": "durable config -> keep",
     "assertion": TRIAGE_ASSERTION,
     "state": DURABLE, "expect_true": False},
    {"kind": "choice", "name": "choice A/B explicit",
     "state": DURABLE,
     "candidates": ["store (durable)", "skip (trivial)"],
     "criteria": "Choose 'store' if the state contains durable config/knowledge, else 'skip'.",
     "expect": "store (durable)"},
    {"kind": "score", "name": "score 1-5",
     "state": "user: hi\nassistant: hello", "levels": ["1", "2", "3", "4", "5"],
     "criteria": "How much durable knowledge is in this state? 1=none, 5=lots"},
]


def selftest(backend: LlamaCppBackend, cfg: dict[str, Any]) -> int:
    health = backend.health()
    print(f"# upstream: {json.dumps(health)}")
    print(f"# config:   backend={cfg['backend']} transport={cfg.get('transport')} "
          f"provider={cfg['provider']} T={cfg['temperature_scaling']} "
          f"abstain={cfg['abstain_threshold']} noul={cfg['noul_threshold']}")
    if health.get("status") != "ok":
        print("# ABORT: upstream llama.cpp not reachable at " + backend.base_url)
        return 2
    failures = 0
    for case in SELFTEST_CASES:
        req = {k: v for k, v in case.items() if k not in ("name", "expect", "expect_true")}
        out = safe_dispatch(backend, cfg, req)
        verdict = "?"
        if "expect_true" in case:
            ok = out.get("value") == case["expect_true"]
            verdict = f"expect value={case['expect_true']} -> {'PASS' if ok else 'FAIL'}"
            failures += 0 if ok else 1
        elif "expect" in case:
            ok = out.get("value") == case["expect"]
            verdict = f"expect value={case['expect']!r} -> {'PASS' if ok else 'FAIL'}"
            failures += 0 if ok else 1
        print(f"\n## {case['name']}  [{verdict}]")
        print(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\n# selftest complete: {len(SELFTEST_CASES) - failures}/{len(SELFTEST_CASES)} passed")
    return 1 if failures else 0


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="openjevserver.py",
        description="OpenJev decision backend (llama.cpp or an opencode provider).")
    p.add_argument("--config", default=DEFAULT_CONFIG,
                   help=f"sysop-config.yaml to read the decisions: block from (default: {DEFAULT_CONFIG})")
    p.add_argument("--base-url", help="endpoint override (llama.cpp or OpenAI-compatible)")
    p.add_argument("--model", help="opencode spec <provider>/<model> (overrides config)")
    p.add_argument("--backend", help='"" = auto opencode provider; "llamacpp" = local')
    p.add_argument("--api-provider", help="provider id when the model has no <provider>/ prefix")
    p.add_argument("--api-key-file", help="path to a chmod-600 API key file (overrides provider)")
    p.add_argument("--auth-file", help="override path to opencode auth.json")
    p.add_argument("--models-file", help="override path to opencode models.json")
    p.add_argument("--transport", choices=("chat", "completion"),
                   help="llama.cpp prob transport (chat is required for Bonsai)")
    p.add_argument("--temperature-scaling", type=float)
    p.add_argument("--abstain-threshold", type=float)
    p.add_argument("--noul-threshold", type=float)
    p.add_argument("--timeout-ms", type=int)
    p.add_argument("--n-probs", type=int)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8091)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--selftest", action="store_true", help="run built-in cases and exit")
    mode.add_argument("--oneshot", action="store_true", help="read one JSON request on stdin")
    mode.add_argument("--request", help="run one JSON request given as an argument")
    return p


def apply_overrides(cfg: dict[str, Any], args: argparse.Namespace) -> None:
    mapping = {
        "base_url": args.base_url, "model": args.model, "backend": args.backend,
        "api_provider": args.api_provider, "api_key_file": args.api_key_file,
        "auth_file": args.auth_file, "models_file": args.models_file,
        "transport": args.transport,
        "temperature_scaling": args.temperature_scaling,
        "abstain_threshold": args.abstain_threshold,
        "noul_threshold": args.noul_threshold,
        "timeout_ms": args.timeout_ms, "n_probs": args.n_probs,
    }
    for key, value in mapping.items():
        if value is not None:
            cfg[key] = value


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    apply_overrides(cfg, args)
    backend = make_backend(cfg)

    if args.selftest:
        return selftest(backend, cfg)
    if args.oneshot:
        try:
            req = json.loads(sys.stdin.read() or "{}")
        except Exception as exc:  # noqa: BLE001
            json.dump({"error": f"invalid stdin JSON: {exc}"}, sys.stdout)
            return 1
        json.dump(safe_dispatch(backend, cfg, req), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    if args.request:
        try:
            req = json.loads(args.request)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"invalid --request JSON: {exc}"}, indent=2))
            return 1
        print(json.dumps(safe_dispatch(backend, cfg, req), indent=2, ensure_ascii=False))
        return 0
    return serve(backend, cfg, args.host, args.port)


if __name__ == "__main__":
    raise SystemExit(main())
