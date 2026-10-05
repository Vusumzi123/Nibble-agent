#!/usr/bin/env python3
"""Idea expression — deterministic, model-free delivery of a stored idea.

Runs from a `systemd --user` timer (a few times a week), independent of
opencode. It reads the browsable bucket note (`Brain/Ideas.md`), picks one
idea that has not been expressed recently, and delivers it over each enabled
channel (Telegram + email). See docs/idea-hook-plan.md §6.

Stdlib only. Reads `sysop-config.yaml` (`paths.*` + `idea.*`). No secrets are
stored here: the Telegram token/chat id come from the chmod-600 credential
files and email goes through `msmtp`'s keyring-backed default account.

Usage:
    idea-express.py [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sysop_config import expand_home, read_section, resolve_leaf, resolve_root  # noqa: E402

# script -> <repo>/.opencode/scripts/idea-express.py
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG_PATH = os.path.join(REPO_ROOT, ".opencode", "sysop-config.yaml")

PATH_DEFAULTS = {"vault": "Brain", "sysop": "~/.opencode-sysop", "state": ".opencode/state"}
IDEA_DEFAULTS: dict[str, Any] = {
    "bucket_file": "Ideas.md",
    "express_min_gap_hours": 48,
    "express_token_file": "~/.config/update-reminder/telegram-token",
    "express_chat_id_file": "~/.config/update-reminder/telegram-chat-id",
    "express_parse_mode": "Markdown",
    "express_telegram": True,
    "express_email": True,
    "express_email_to": "",
    "express_email_bin": "msmtp",
}

IDEA_COMMENT_RE = re.compile(r"<!--\s*idea:\s*(\{.*?\})\s*-->", re.S)
HEADING3_RE = re.compile(r"^###\s+(.*)$")
HEADING2_RE = re.compile(r"^##\s+")


def log_line(path: str, entry: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def idea_hash(body: str) -> str:
    return hashlib.sha1(body.strip().encode("utf-8")).hexdigest()[:8]


def parse_bucket(text: str) -> list[dict[str, str]]:
    """Tolerant parse of `### <title>` sections (mirrors lib/idea.ts)."""
    lines = (text or "").split("\n")
    entries: list[dict[str, str]] = []
    i = 0
    while i < len(lines):
        if not HEADING3_RE.match(lines[i]):
            i += 1
            continue
        title = HEADING3_RE.match(lines[i]).group(1).strip()
        chunk: list[str] = []
        i += 1
        while i < len(lines) and not HEADING3_RE.match(lines[i]) and not HEADING2_RE.match(lines[i]):
            chunk.append(lines[i])
            i += 1
        raw = "\n".join(chunk)
        body = IDEA_COMMENT_RE.sub("", raw).strip()
        if not title or not body:
            continue
        meta: dict[str, str] = {}
        m = IDEA_COMMENT_RE.search(raw)
        if m:
            try:
                parsed = json.loads(m.group(1))
                if isinstance(parsed, dict):
                    meta = parsed
            except (ValueError, TypeError):
                continue  # malformed comment -> skip this entry
        entries.append(
            {
                "title": title,
                "category": str(meta.get("category", "note")),
                "id": str(meta.get("id") or f"idea-{idea_hash(body)}"),
                "created": str(meta.get("created", "")),
                "hash": str(meta.get("hash") or idea_hash(body)),
                "body": body,
            }
        )
    return entries


def load_state(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return {"lastExpressedAt": data.get("lastExpressedAt"), "recentHashes": list(data.get("recentHashes") or [])}
    except (OSError, ValueError):
        pass
    return {"lastExpressedAt": None, "recentHashes": []}


def save_state(path: str, state: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def chunk_text(text: str, limit: int) -> list[str]:
    return [text[i : i + limit] for i in range(0, len(text), limit)] or [""]


def send_telegram(
    message: str,
    token_file: str,
    chat_file: str,
    parse_mode: str,
) -> tuple[bool, str]:
    try:
        with open(expand_home(token_file), "r", encoding="utf-8") as fh:
            token = fh.read().strip()
        with open(expand_home(chat_file), "r", encoding="utf-8") as fh:
            chat_id = fh.read().strip()
    except OSError as err:
        return False, f"credentials unreadable: {err}"
    if not token or not chat_id:
        return False, "missing token/chat id"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        for part in chunk_text(message, 4096):
            payload: dict[str, str] = {"chat_id": chat_id, "text": part}
            if parse_mode:
                payload["parse_mode"] = parse_mode
            data = urllib.parse.urlencode(payload).encode("utf-8")
            with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as resp:
                resp.read()
    except Exception as err:  # noqa: BLE001 - network failures are data
        return False, f"telegram send failed: {err}"
    return True, "sent"


def send_email(message: str, subject: str, to: str, binary: str) -> tuple[bool, str]:
    body = f"Subject: {subject}\n\n{message}\n"
    try:
        proc = subprocess.run(
            [binary, to],
            input=body.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as err:
        return False, f"msmtp failed: {err}"
    if proc.returncode != 0:
        return False, f"msmtp exited {proc.returncode}: {proc.stderr.decode('utf-8', 'replace').strip()}"
    return True, "sent"


def main() -> int:
    parser = argparse.ArgumentParser(description="Express one stored idea via Telegram/email.")
    parser.add_argument("--dry-run", action="store_true", help="print instead of sending")
    args = parser.parse_args()

    paths = read_section(CONFIG_PATH, "paths", PATH_DEFAULTS)
    idea = read_section(CONFIG_PATH, "idea", IDEA_DEFAULTS)

    vault_dir = resolve_root(REPO_ROOT, str(paths.get("vault", "Brain")))
    sysop_dir = resolve_root(os.path.expanduser("~"), str(paths.get("sysop", "~/.opencode-sysop")))
    bucket_file = resolve_leaf(vault_dir, str(idea.get("bucket_file", "Ideas.md")))
    state_file = os.path.join(sysop_dir, "idea-express.json")
    log_file = os.path.join(sysop_dir, "idea-express.log")

    state = load_state(state_file)
    now_ms = int(time.time() * 1000)
    min_gap_ms = int(float(idea.get("express_min_gap_hours", 48)) * 3600_000)
    last = state.get("lastExpressedAt")

    if not args.dry_run and isinstance(last, (int, float)) and now_ms - int(last) < min_gap_ms:
        return 0

    try:
        with open(bucket_file, "r", encoding="utf-8") as fh:
            ideas = parse_bucket(fh.read())
    except OSError as err:
        log_line(log_file, {"ts": now_ms, "event": "idea-express-skip", "reason": "bucket-unreadable", "error": str(err)})
        return 0

    if not ideas:
        log_line(log_file, {"ts": now_ms, "event": "idea-express-skip", "reason": "no-ideas"})
        return 0

    recent = set(state.get("recentHashes") or [])
    pool = [i for i in ideas if i["hash"] not in recent]
    if not pool:
        state["recentHashes"] = []  # every idea consumed -> reset the history
        pool = ideas

    pick = random.choice(pool)
    message = pick["body"]
    subject = f"Idea: {pick['title']}"

    if args.dry_run:
        print(f"[dry-run] channel plan: telegram={idea.get('express_telegram')} email={idea.get('express_email')}")
        print(f"[dry-run] to: {idea.get('express_email_to')} subject: {subject}")
        print(f"[dry-run] title: {pick['title']} category: {pick['category']} hash: {pick['hash']}")
        print(message)
        return 0

    results: dict[str, tuple[bool, str]] = {}
    if idea.get("express_telegram", True):
        results["telegram"] = send_telegram(
            message,
            str(idea.get("express_token_file", "")),
            str(idea.get("express_chat_id_file", "")),
            str(idea.get("express_parse_mode", "")),
        )
    email_to = str(idea.get("express_email_to", "")).strip()
    if idea.get("express_email", True) and email_to:
        results["email"] = send_email(
            message,
            subject,
            email_to,
            str(idea.get("express_email_bin", "msmtp")),
        )

    succeeded = [name for name, (ok, _) in results.items() if ok]
    if succeeded:
        state["lastExpressedAt"] = now_ms
        state["recentHashes"] = (list(state.get("recentHashes") or []) + [pick["hash"]])[-20:]
        save_state(state_file, state)

    log_line(
        log_file,
        {
            "ts": now_ms,
            "event": "idea-express" if succeeded else "idea-express-failed",
            "title": pick["title"],
            "category": pick["category"],
            "hash": pick["hash"],
            "channels": {name: {"ok": ok, "detail": detail} for name, (ok, detail) in results.items()},
            "succeeded": succeeded,
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
