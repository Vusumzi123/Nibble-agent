#!/usr/bin/env python3
"""Evaluation harness for the Jev decision provider (plan §8, P3).

Offline, stdlib-only. Reads the shadow decision ledger and the knowledge-hook
drain log, joins them on session id to fill in ``eventualOutcome``, then reports
three arms against each other:

  OFF         the baseline knowledge-hook drains (cost + latency, autoSkipped=0)
  ON shadow   OFF + the decision overhead (calls, latency, token consumption)
  ON gate     OFF - the drain cost that a correct skip would have avoided

It also projects gate-mode savings from the *historical* drain costs in
``knowledge-hook.log`` (weak labels), and emits an offline markdown + JSON
report. It never talks to a model or the network.

Usage:
  python3 scripts/eval_decisions.py [--ledger L] [--knowledge-log K] \\
      [--config C] [--out-prefix P] [--sweep-min .5 --sweep-max .95 --sweep-step .05]

Everything is derived deterministically from the two NDJSON logs; no live
backend is required.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import statistics
import sys
import time
from datetime import datetime, timezone
from typing import Any

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_CONFIG = os.path.join(REPO_ROOT, ".opencode", "sysop-config.yaml")
DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")

# Import the decisions-block reader from the bridge's own module (same dir) so
# the harness and the bridge can never drift on config parsing. The script's own
# directory is on sys.path when run directly, so this resolves openjevserver.py.
from openjevserver import (  # noqa: E402
    TRIAGE_ASSERTION,
    load_config,
    make_backend,
    safe_dispatch,
)


# --------------------------------------------------------------------------- #
# Loading                                                                      #
# --------------------------------------------------------------------------- #
def _load_ndjson(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path or not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def load_outcomes(knowledge_log: str) -> dict[str, str]:
    """session id -> eventual outcome, from knowledge-hook drain events.

    ``consolidated`` means the drain produced a note (durable knowledge —
    skipping it would lose knowledge); ``skipped`` means the drain ran and found
    nothing worth saving (safe to have skipped); ``failed`` covers a session in
    a batch that neither consolidated nor skipped.
    """
    outcomes: dict[str, str] = {}
    for row in _load_ndjson(knowledge_log):
        if row.get("event") != "drain":
            continue
        batch = row.get("batch") or []
        consolidated = set(row.get("consolidated") or [])
        skipped = set(row.get("skipped") or [])
        for sid in batch:
            if sid in consolidated:
                outcomes[sid] = "consolidated"
            elif sid in skipped:
                outcomes[sid] = "skipped"
            else:
                outcomes.setdefault(sid, "failed")
    return outcomes


def load_drains(knowledge_log: str) -> list[dict[str, Any]]:
    """Drain events with the fields the savings projection needs."""
    drains: list[dict[str, Any]] = []
    for row in _load_ndjson(knowledge_log):
        if row.get("event") != "drain":
            continue
        child = row.get("child") or {}
        cost = child.get("cost")
        drains.append({
            "batch": row.get("batch") or [],
            "consolidated": set(row.get("consolidated") or []),
            "skipped": set(row.get("skipped") or []),
            "cost": float(cost) if isinstance(cost, (int, float)) else 0.0,
            "durationMs": row.get("durationMs"),
            "usageKnown": child.get("usageKnown"),
        })
    return drains


# --------------------------------------------------------------------------- #
# RulesProvider port — classifyTranscript (autonomy.ts:713-781)
#                                                                              #
# A faithful Python port of the deterministic baseline classifier, used only by
# the corpus replay to compare the model against the heuristic on the same
# transcripts. `re.ASCII` mirrors JS's default (non-unicode) \b/\w semantics.
# --------------------------------------------------------------------------- #
_A = re.ASCII

_SIGNAL_PATTERNS = [
    re.compile(r"```|~~~"),
    re.compile(r"\b(?:sudo|systemctl|pacman|yay|paru|apt|dnf|docker|podman|git|npm|pnpm|bun|python3?|pip|node|make|cmake|nix|flatpak|snap)\b", _A | re.I),
    re.compile(r"(?:^|\s)(?:\./|~/|/etc/|/usr/|/home/|/var/|/opt/|/boot/|[A-Za-z]:\\)"),
    re.compile(r"\bhttps?://", _A | re.I),
    re.compile(r"\b[A-Z][A-Z0-9_]{2,}=\S"),
    re.compile(r"\b[\w.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|conf|service|sh|py|rs|go|cpp|h)\b", _A | re.I),
    re.compile(r"--[a-z][\w-]{1,}", _A | re.I),
    re.compile(r"\b(?:btrfs|systemd|kernel|grub|fstab|wayland|x11|nvidia|pipewire|wireplumber|firewall|nftables|iptables|ssh|gpg|zfs|luks|opencode|mcp)\b", _A | re.I),
]
_DURABLE_SIGNAL_PATTERNS = [
    re.compile(r"\b(?:remember|decided|decision|convention|policy|prefer|preference|always|never|instead|gotcha|root cause|workaround|important|note to self|do not|don't|should)\b", _A | re.I),
]
_TRIVIAL_PATTERNS = [
    re.compile(r"^(?:thanks|thank you|ty|ok|okay|k|got it|sure|yep|yes|no|nope|done|great|cool|nice|hi|hello|hey|cheers|perfect|awesome|sounds good|understood|welcome|you're welcome|no problem|anytime|glad to help|let me know|👍|👋)[.!]?$", _A | re.I),
]
_QUESTION_RE = re.compile(r"[?？]|\b(?:how|what|why|where|when|which|who|can|could|should|does|do|is|are|will|would)\b", _A | re.I)
_USER_RE = re.compile(r"##\s*User\s*\n([\s\S]*?)(?=\n##\s*Assistant|$)")
_ASSISTANT_RE = re.compile(r"##\s*Assistant\s*\n([\s\S]*)$")
_TURN_SPLIT_RE = re.compile(r"<!--\s*turn:\s*\d+\s*-->")


def has_durable_signal(content: str) -> bool:
    return (
        any(p.search(content) for p in _SIGNAL_PATTERNS)
        or any(p.search(content) for p in _DURABLE_SIGNAL_PATTERNS)
    )


def split_transcript_turns(content: str) -> list[dict[str, str]]:
    turns: list[dict[str, str]] = []
    for chunk in _TURN_SPLIT_RE.split(content):
        if not chunk.strip():
            continue
        um = _USER_RE.search(chunk)
        am = _ASSISTANT_RE.search(chunk)
        turns.append({
            "user": (um.group(1).strip() if um else ""),
            "assistant": (am.group(1).strip() if am else ""),
        })
    return turns


def classify_transcript(content: str, max_bytes: int) -> dict[str, Any]:
    if len(content.encode("utf-8")) > max_bytes:
        return {"skip": False, "reason": "over-size"}
    if has_durable_signal(content):
        return {"skip": False, "reason": "durable-signal"}
    turns = split_transcript_turns(content)
    if not turns:
        return {"skip": False, "reason": "unparseable"}
    for t in turns:
        if _QUESTION_RE.search(t["user"]):
            return {"skip": False, "reason": "question"}
    for t in turns:
        user_filler = t["user"] == "" or any(p.search(t["user"]) for p in _TRIVIAL_PATTERNS)
        assistant_filler = t["assistant"] == "" or any(p.search(t["assistant"]) for p in _TRIVIAL_PATTERNS)
        if not user_filler or not assistant_filler:
            return {"skip": False, "reason": "non-trivial-turn"}
    return {"skip": True, "reason": "trivial-chatter"}


def render_turn_block(turn: int, user: str, assistant: str) -> str:
    return "\n".join([
        f"<!-- turn: {turn} -->",
        "",
        "## User",
        "",
        user.strip(),
        "",
        "## Assistant",
        "",
        assistant.strip(),
    ])


# --------------------------------------------------------------------------- #
# Corpus replay (opencode.db -> transcripts -> model + rules -> replay ledger)
# --------------------------------------------------------------------------- #
def load_corpus(db_path: str, limit: int, max_bytes: int,
                labeled_only: bool, outcomes: dict[str, str]) -> list[tuple[str, str]]:
    """Rebuild per-session transcripts from opencode.db.

    Mirrors knowledge-hook's capture: a turn is the (user text, assistant text)
    pair, where text parts are `type == "text"` and neither synthetic nor
    ignored, rendered in the same `<!-- turn: N -->` block format the classifier
    and triage prompt expect. Child/subagent sessions are excluded.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_created"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = con.execute("SELECT id FROM session ORDER BY time_created").fetchall()
    sessions = [r["id"] for r in rows]
    if labeled_only:
        sessions = [s for s in sessions if s in outcomes]
    if limit and limit > 0:
        sessions = sessions[:limit]

    corpus: list[tuple[str, str]] = []
    for sid in sessions:
        msgs = con.execute(
            "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id",
            (sid,),
        ).fetchall()
        if not msgs:
            continue
        parts: dict[str, list[str]] = {}
        for pr in con.execute(
            "SELECT message_id, data FROM part WHERE session_id=? ORDER BY time_created, id",
            (sid,),
        ):
            try:
                p = json.loads(pr["data"])
            except json.JSONDecodeError:
                continue
            if p.get("type") != "text" or p.get("synthetic") or p.get("ignored"):
                continue
            parts.setdefault(pr["message_id"], []).append(p.get("text") or "")

        turns: list[tuple[str, str]] = []
        pending = ""
        for m in msgs:
            try:
                info = json.loads(m["data"])
            except json.JSONDecodeError:
                continue
            role = info.get("role")
            text = "\n".join(parts.get(m["id"], [])).strip()
            if not text:
                continue
            if role == "user":
                pending = text
            elif role == "assistant":
                turns.append((pending, text))
                pending = ""
        if not turns:
            continue
        content = "\n\n".join(
            render_turn_block(i + 1, u, a) for i, (u, a) in enumerate(turns)
        ) + "\n"
        if len(content.encode("utf-8")) > max_bytes:
            continue
        corpus.append((sid, content))
    con.close()
    return corpus


def replay_corpus(args: argparse.Namespace, cfg: dict[str, Any],
                  outcomes: dict[str, str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run the model's triage over the corpus and return replay-ledger rows."""
    backend = make_backend(cfg)
    health = backend.health()
    if health.get("status") != "ok":
        print(f"# replay abort: upstream not reachable ({health})", file=sys.stderr)
        return [], {"sessions": 0, "aborted": True}

    corpus = load_corpus(
        args.corpus_db, args.replay_limit, args.replay_max_bytes,
        args.replay_labeled_only, outcomes,
    )
    total = len(corpus)
    print(f"# replay: {total} session(s) from {args.corpus_db}", file=sys.stderr)

    decisions: list[dict[str, Any]] = []
    for i, (sid, content) in enumerate(corpus, 1):
        rules = classify_transcript(content, args.skip_triage_max_bytes)
        started = time.monotonic()
        out = safe_dispatch(backend, cfg, {
            "kind": "noul", "state": content, "assertion": TRIAGE_ASSERTION,
            "allow_abstain": False,
        })
        wall = int((time.monotonic() - started) * 1000)

        usable = (
            not out.get("error")
            and out.get("abstained") is not True
            and out.get("value") is not None
        )
        if usable:
            provider = out.get("provider", "openjev")
            backend_name = out.get("backend", "llamacpp")
            value = out.get("value")
            fallback = False
            reason = "none"
        else:
            provider = "rules"
            backend_name = "rules"
            value = rules["skip"]
            fallback = True
            reason = "error" if out.get("error") else ("abstain" if out.get("abstained") else "shape")

        usage = out.get("usage") or {}
        probs = out.get("probabilities") or {}
        decisions.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "session": sid,
            "provider": provider,
            "backend": backend_name,
            "model": out.get("model"),
            "mode": cfg.get("mode", "shadow"),
            "kind": "noul",
            "value": value,
            "confidence": out.get("confidence", 0),
            "pTrue": probs.get("true") if isinstance(probs.get("true"), (int, float)) else None,
            "abstained": bool(out.get("abstained")),
            "latencyMs": out.get("latencyMs", 0),
            "wallMs": wall,
            "promptTokens": usage.get("promptTokens"),
            "completionTokens": usage.get("completionTokens"),
            "totalTokens": usage.get("totalTokens"),
            "promptMs": usage.get("promptMs"),
            "promptTokensPerSecond": usage.get("promptTokensPerSecond"),
            "usageKnown": bool(usage.get("usageKnown")),
            "fallback": fallback,
            "fallbackReason": reason,
            "rulesVerdict": rules,
            "eventualOutcome": None,
        })
        if i % 25 == 0 or i == total:
            print(f"# replay: {i}/{total}", file=sys.stderr)

    meta = {
        "kind": "replay",
        "source": args.corpus_db,
        "sessions": total,
        "limit": args.replay_limit,
        "maxBytes": args.replay_max_bytes,
        "labeledOnly": args.replay_labeled_only,
        "aborted": False,
    }
    return decisions, meta


# --------------------------------------------------------------------------- #
# Metrics                                                                      #
# --------------------------------------------------------------------------- #
def _pct(part: float, whole: float) -> float | None:
    if whole <= 0:
        return None
    return part / whole


def _percentiles(values: list[float], ps: tuple[float, ...] = (50, 95)) -> dict[str, float]:
    if not values:
        out = {f"p{int(p)}": 0.0 for p in ps}
        out["max"] = 0.0
        return out
    ordered = sorted(values)
    out: dict[str, float] = {}
    for p in ps:
        k = (len(ordered) - 1) * (p / 100.0)
        lo = math.floor(k)
        hi = math.ceil(k)
        if lo == hi:
            out[f"p{int(p)}"] = ordered[lo]
        else:
            out[f"p{int(p)}"] = ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)
    out["max"] = ordered[-1]
    return out


def _mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def compute_ece(preds: list[float], actuals: list[int], n_bins: int = 10) -> float:
    """Expected Calibration Error over probability bins (plan §8)."""
    if not preds:
        return 0.0
    bins: list[list[tuple[float, int]]] = [[] for _ in range(n_bins)]
    for p, y in zip(preds, actuals):
        idx = min(n_bins - 1, max(0, int(p * n_bins)))
        bins[idx].append((p, y))
    ece = 0.0
    total = float(len(preds))
    for bucket in bins:
        if not bucket:
            continue
        conf = sum(p for p, _ in bucket) / len(bucket)
        acc = sum(y for _, y in bucket) / len(bucket)
        ece += (len(bucket) / total) * abs(conf - acc)
    return ece


# --------------------------------------------------------------------------- #
# Analysis                                                                     #
# --------------------------------------------------------------------------- #
def analyze(decisions: list[dict[str, Any]], drains: list[dict[str, Any]],
            outcomes: dict[str, str], cfg: dict[str, Any],
            sweep: list[float], price_prompt_per_mtok: float) -> dict[str, Any]:
    noul = [d for d in decisions if d.get("kind") == "noul"]
    bridge = [d for d in decisions if d.get("provider") != "rules"]

    # --- Coverage / fallback / abstain --------------------------------------
    fallback_count = sum(1 for d in noul if d.get("fallback"))
    abstain_count = sum(1 for d in noul if d.get("abstained"))
    fallback_reasons: dict[str, int] = {}
    for d in noul:
        r = d.get("fallbackReason") or ("unknown" if d.get("fallback") else "none")
        fallback_reasons[r] = fallback_reasons.get(r, 0) + 1

    joined = sum(1 for d in noul if d.get("session") in outcomes)

    # --- Performance (ON overhead) ------------------------------------------
    latencies = [d["latencyMs"] for d in bridge if isinstance(d.get("latencyMs"), (int, float))]
    walls = [d["wallMs"] for d in bridge if isinstance(d.get("wallMs"), (int, float))]
    prompt_tokens = [d["promptTokens"] for d in bridge if isinstance(d.get("promptTokens"), (int, float))]
    completion_tokens = [d["completionTokens"] for d in bridge if isinstance(d.get("completionTokens"), (int, float))]
    total_tokens = [d["totalTokens"] for d in bridge if isinstance(d.get("totalTokens"), (int, float))]
    usage_known = sum(1 for d in bridge if d.get("usageKnown"))
    sum_prompt = sum(prompt_tokens)
    hosted_cost = (sum_prompt / 1_000_000.0) * price_prompt_per_mtok

    # --- Model effectiveness (non-fallback noul only) ------------------------
    model_preds = [d for d in noul if not d.get("fallback") and isinstance(d.get("value"), bool)]
    tp = fp = tn = fn = 0
    preds: list[float] = []
    actuals: list[int] = []
    for d in model_preds:
        outcome = outcomes.get(d.get("session"))
        skip_pred = d["value"] is True
        skippable = outcome == "skipped"
        if outcome == "consolidated":
            if skip_pred:
                fp += 1
            else:
                tn += 1
            actuals.append(0)
        elif outcome == "skipped":
            if skip_pred:
                tp += 1
            else:
                fn += 1
            actuals.append(1)
        else:
            continue  # no ground-truth label -> excluded from quality metrics
        p = d.get("pTrue")
        if isinstance(p, (int, float)):
            preds.append(float(p))

    labeled = tp + fp + tn + fn
    # Primary metric (plan §8): "drain-recall" = of the durable (consolidated)
    # sessions, what fraction did the model correctly *not* skip. A false skip
    # loses knowledge, so this recall of the "drain" class is the safety gate.
    drain_recall = _pct(tn, tn + fp)
    false_skip_rate = _pct(fp, tn + fp)
    precision = _pct(tp, tp + fp)
    skip_recall = _pct(tp, tp + fn)
    f1 = (2 * precision * skip_recall / (precision + skip_recall)) if precision and skip_recall else None
    ece = compute_ece(preds, actuals)

    # --- Gate savings projection (from historical drain costs) ---------------
    baseline_cost = sum(d["cost"] for d in drains)
    baseline_duration = sum(d["durationMs"] for d in drains if isinstance(d.get("durationMs"), (int, float)))
    baseline_drains = len(drains)

    decisions_by_session: dict[str, dict[str, Any]] = {}
    for d in noul:
        decisions_by_session[d.get("session")] = d

    noul_threshold = float(cfg.get("noul_threshold", 0.80))

    def gated_skip(d: dict[str, Any] | None, t: float) -> bool:
        if not d:
            return False
        if d.get("fallback") or d.get("abstained"):
            return False
        if d.get("value") is not True:
            return False
        p = d.get("pTrue")
        return isinstance(p, (int, float)) and p >= t

    def savings_at(t: float) -> dict[str, Any]:
        avoided_cost = 0.0
        avoided_drains = 0
        false_skips = 0
        safe_skips = 0
        for dr in drains:
            batch = dr["batch"]
            if not batch:
                continue
            all_skip = True
            for sid in batch:
                d = decisions_by_session.get(sid)
                if not (gated_skip(d, t) and outcomes.get(sid) == "skipped"):
                    all_skip = False
            if all_skip:
                avoided_cost += dr["cost"]
                avoided_drains += 1
        for d in noul:
            if gated_skip(d, t):
                if outcomes.get(d.get("session")) == "consolidated":
                    false_skips += 1
                elif outcomes.get(d.get("session")) == "skipped":
                    safe_skips += 1
        return {
            "threshold": t,
            "avoidedDrains": avoided_drains,
            "avoidedCost": round(avoided_cost, 6),
            "falseSkips": false_skips,
            "safeSkips": safe_skips,
        }

    sweep_rows = [savings_at(t) for t in sweep]
    configured = savings_at(noul_threshold)

    return {
        "config": {
            "provider": cfg.get("provider"),
            "backend": cfg.get("backend"),
            "model": cfg.get("model"),
            "mode": cfg.get("mode"),
            "noulThreshold": noul_threshold,
            "abstainThreshold": cfg.get("abstain_threshold"),
            "pricePromptPerMTok": price_prompt_per_mtok,
        },
        "coverage": {
            "decisions": len(decisions),
            "noul": len(noul),
            "bridge": len(bridge),
            "fallback": fallback_count,
            "fallbackRate": _pct(fallback_count, len(noul)) if noul else 0.0,
            "fallbackReasons": fallback_reasons,
            "abstained": abstain_count,
            "abstainRate": _pct(abstain_count, len(noul)) if noul else 0.0,
            "joinedWithOutcome": joined,
            "joinRate": _pct(joined, len(noul)) if noul else 0.0,
        },
        "performance": {
            "calls": len(bridge),
            "latencyMs": _percentiles(latencies),
            "latencyMeanMs": round(_mean(latencies), 3),
            "wallMs": _percentiles(walls),
            "wallMeanMs": round(_mean(walls), 3),
            "promptTokensTotal": sum_prompt,
            "promptTokensMean": round(_mean(prompt_tokens), 3),
            "completionTokensTotal": sum(completion_tokens),
            "totalTokens": sum(total_tokens),
            "usageKnown": usage_known,
            "usageKnownRate": _pct(usage_known, len(bridge)) if bridge else 0.0,
            "hostedCostProjected": round(hosted_cost, 8),
        },
        "effectiveness": {
            "modelPredictions": len(model_preds),
            "labeled": labeled,
            "truePositive": tp,
            "falsePositive": fp,
            "trueNegative": tn,
            "falseNegative": fn,
            "drainRecall": drain_recall,
            "falseSkipRate": false_skip_rate,
            "precision": precision,
            "skipRecall": skip_recall,
            "f1": f1,
            "ece": round(ece, 4),
        },
        "savings": {
            "baselineDrains": baseline_drains,
            "baselineCost": round(baseline_cost, 6),
            "baselineDurationMs": int(baseline_duration),
            "configured": configured,
            "sweep": sweep_rows,
        },
    }


# --------------------------------------------------------------------------- #
# Report                                                                       #
# --------------------------------------------------------------------------- #
def _pct_str(v: float | None) -> str:
    return "—" if v is None else f"{v * 100:.1f}%"


def _num(v: Any, nd: int = 3) -> str:
    if v is None:
        return "—"
    return f"{v:,.{nd}f}"


def render_markdown(rep: dict[str, Any], ledger: str, knowledge_log: str) -> str:
    cov = rep["coverage"]
    perf = rep["performance"]
    eff = rep["effectiveness"]
    sav = rep["savings"]
    cfg = rep["config"]
    meta = rep.get("meta") or {}

    lines: list[str] = []
    lines += [
        "# Jev Decision Provider — Evaluation Report",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat()}",
        f"- Source: `{ledger}`" + (
            f" (corpus replay: {meta.get('sessions', 0)} sessions, "
            f"max {meta.get('maxBytes')} B, labeledOnly={meta.get('labeledOnly')})"
            if meta.get("kind") == "replay" else ""
        ),
        f"- Decisions: {cov['decisions']} | Knowledge log: `{knowledge_log}` ({sav['baselineDrains']} drains)",
        f"- Config: provider=`{cfg['provider']}` backend=`{cfg['backend']}` "
        f"model=`{cfg['model']}` mode=`{cfg['mode']}`",
        "",
        "## 1. Coverage & traceability",
        "",
        f"| metric | value |",
        f"|---|---|",
        f"| decisions (noul) | {cov['noul']} |",
        f"| fallback rate | {_pct_str(cov['fallbackRate'])} ({cov['fallback']}) |",
        f"| abstain rate | {_pct_str(cov['abstainRate'])} ({cov['abstained']}) |",
        f"| joined with drain outcome | {_pct_str(cov['joinRate'])} ({cov['joinedWithOutcome']}) |",
    ]
    lines += ["", "Fallback reasons:"]
    for r, c in sorted(cov["fallbackReasons"].items()):
        lines.append(f"- {r}: {c}")

    lines += [
        "",
        "## 2. Performance — ON overhead",
        "",
        f"| metric | value |",
        f"|---|---|",
        f"| bridge calls | {perf['calls']} |",
        f"| backend latency p50 / p95 / max (ms) | {perf['latencyMs']['p50']:.0f} / {perf['latencyMs']['p95']:.0f} / {perf['latencyMs']['max']:.0f} |",
        f"| subprocess wall p50 / p95 / max (ms) | {perf['wallMs']['p50']:.0f} / {perf['wallMs']['p95']:.0f} / {perf['wallMs']['max']:.0f} |",
        f"| prompt tokens (total / mean) | {perf['promptTokensTotal']:,} / {_num(perf['promptTokensMean'])} |",
        f"| completion tokens (total) | {perf['completionTokensTotal']:,} |",
        f"| total tokens | {perf['totalTokens']:,} |",
        f"| usageKnown | {_pct_str(perf['usageKnownRate'])} ({perf['usageKnown']}) |",
        f"| projected hosted cost @ ${cfg['pricePromptPerMTok']}/MTok | ${_num(perf['hostedCostProjected'], 8)} |",
    ]

    lines += [
        "",
        "## 3. Effectiveness — model quality (non-fallback)",
        "",
        f"| metric | value |",
        f"|---|---|",
        f"| labeled predictions | {eff['labeled']} |",
        f"| true positive (skip→skipped) | {eff['truePositive']} |",
        f"| false positive (skip→consolidated) | {eff['falsePositive']} |",
        f"| true negative | {eff['trueNegative']} |",
        f"| false negative | {eff['falseNegative']} |",
        f"| drain-recall (primary safety) | {_pct_str(eff['drainRecall'])} |",
        f"| false-skip rate | {_pct_str(eff['falseSkipRate'])} |",
        f"| precision (of skip calls) | {_pct_str(eff['precision'])} |",
        f"| skip-recall (savings coverage) | {_pct_str(eff['skipRecall'])} |",
        f"| F1 | {_num(eff['f1'], 4)} |",
        f"| ECE | {_num(eff['ece'], 4)} |",
        "",
        "> Primary safety metric is **drain-recall** (of durable sessions, how many were "
        "correctly kept). A false skip loses knowledge, so this must stay high before gate mode.",
    ]

    lines += [
        "",
        "## 4. On / Off comparison & gate savings",
        "",
        "| arm | drains | cost | duration |",
        f"|---|---|---|---|",
        f"| OFF (baseline) | {sav['baselineDrains']} | ${_num(sav['baselineCost'], 6)} | {_num(sav['baselineDurationMs'])} ms |",
    ]
    if perf["calls"]:
        lines.append(
            f"| ON shadow overhead | — | ${_num(perf['hostedCostProjected'], 8)} (hosted est.) | {_num(perf['wallMeanMs'])} ms/call |"
        )

    cfgrow = sav["configured"]
    lines += [
        "",
        f"Configured `noul_threshold` = {cfg['noulThreshold']}: "
        f"avoids {cfgrow['avoidedDrains']} drain(s) (${_num(cfgrow['avoidedCost'], 6)}), "
        f"{cfgrow['falseSkips']} false skip(s), {cfgrow['safeSkips']} safe skip(s).",
        "",
        "| noul_threshold | avoided drains | avoided cost | false skips | safe skips |",
        "|---|---|---|---|---|",
    ]
    for row in sav["sweep"]:
        lines.append(
            f"| {row['threshold']:.2f} | {row['avoidedDrains']} | ${_num(row['avoidedCost'], 6)} | "
            f"{row['falseSkips']} | {row['safeSkips']} |"
        )

    lines += [
        "",
        "## 5. Notes",
        "",
        "- Savings are a **conservative lower bound**: a drain is counted avoided only when "
        "*every* session in its batch is a correct skip (predicted skip and outcome `skipped`).",
        "- `eventualOutcome` is a weak label (drain `consolidated` vs `skipped`); it is joined "
        "here, not stored in the ledger.",
        "- Fallback/abstained decisions are resolved by `RulesProvider` (authoritative) and "
        "excluded from quality metrics, so the model is never credited for the rules verdict.",
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="eval_decisions.py",
        description="Offline evaluation of the Jev decision provider (plan §8).")
    p.add_argument("--ledger", default=os.path.expanduser("~/.opencode-sysop/decisions.log"),
                   help="shadow decision ledger (NDJSON)")
    p.add_argument("--knowledge-log", default=os.path.expanduser("~/.opencode-sysop/knowledge-hook.log"),
                   help="knowledge-hook drain log (NDJSON)")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="sysop-config.yaml (decisions: block)")
    p.add_argument("--out-prefix", default=os.path.expanduser("~/.opencode-sysop/decisions-eval"),
                   help="write <prefix>.md and <prefix>.json")
    p.add_argument("--sweep-min", type=float, default=0.50)
    p.add_argument("--sweep-max", type=float, default=0.95)
    p.add_argument("--sweep-step", type=float, default=0.05)
    p.add_argument("--price-prompt-per-mtok", type=float, default=0.0,
                   help="hosted input prompt tokens price per million tokens, for cost projection")

    # Corpus replay: benchmark the model over opencode.db (no shadow ledger needed).
    p.add_argument("--replay", action="store_true",
                   help="replay the opencode.db corpus through the model + rules baseline")
    p.add_argument("--corpus-db", default=DEFAULT_DB, help="opencode.db path (replay source)")
    p.add_argument("--replay-out", default=os.path.expanduser("~/.opencode-sysop/decisions-replay.log"),
                   help="write the replayed decisions to this NDJSON ledger")
    p.add_argument("--replay-limit", type=int, default=0,
                   help="max sessions to replay (0 = all)")
    p.add_argument("--replay-max-bytes", type=int, default=20000,
                   help="skip transcripts larger than this many bytes")
    p.add_argument("--replay-labeled-only", action="store_true",
                   help="only replay sessions that have a knowledge-hook outcome label")
    p.add_argument("--skip-triage-max-bytes", type=int, default=800,
                   help="knowledge.skip_triage_max_bytes for the classifyTranscript port")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    drains = load_drains(args.knowledge_log)
    outcomes = load_outcomes(args.knowledge_log)

    meta: dict[str, Any] = {"kind": "ledger", "source": args.ledger}
    if args.replay:
        decisions, meta = replay_corpus(args, cfg, outcomes)
        if meta.get("aborted"):
            return 2
        with open(args.replay_out, "w", encoding="utf-8") as fh:
            for d in decisions:
                fh.write(json.dumps(d, ensure_ascii=False) + "\n")
        print(f"# wrote replay ledger {args.replay_out} ({len(decisions)} decisions)")
    else:
        decisions = _load_ndjson(args.ledger)

    sweep: list[float] = []
    t = args.sweep_min
    while t <= args.sweep_max + 1e-9:
        sweep.append(round(t, 4))
        t += args.sweep_step

    rep = analyze(decisions, drains, outcomes, cfg, sweep, args.price_prompt_per_mtok)
    rep["meta"] = meta

    md = render_markdown(rep, meta.get("source", args.ledger), args.knowledge_log)
    with open(args.out_prefix + ".md", "w", encoding="utf-8") as fh:
        fh.write(md)
    with open(args.out_prefix + ".json", "w", encoding="utf-8") as fh:
        json.dump(rep, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(md)
    print(f"# wrote {args.out_prefix}.md and {args.out_prefix}.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
