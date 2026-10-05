#!/usr/bin/env python3
"""drawio-xml — deterministic helper for drawing .drawio diagrams.

Stdlib only. No network, no shell-outs. This is the one code path the
diagram-developer agent is allowed to run besides `xmllint` and the
`drawio` desktop CLI.

Subcommands
-----------
  decode <file>            Print the uncompressed XML for a .drawio,
                           .drawio.svg, or .drawio.png file (stdout).
  extract <file>           Alias of decode (reads embedded SVG/PNG).
  encode <in> [out]        Compress each <diagram> body to draw.io's
                           native base64(deflateRaw(uriEncode(xml))) form.
                           Defaults to stdout; never overwrites <in>.
  validate <file>          Structural checks; exit 0 clean, 1 on error.
  info <file>              Human summary: pages, cells, edges.
  flatten-svg <file> [out] Make an exported .drawio.svg render identically in
                           every viewer: collapse light-dark(a,b) to the light
                           value `a`, force `color-scheme: light`, and drop the
                           draw.io "Text is not SVG" warning anchor. In place
                           unless <out> is given.

Exit codes: 0 success/valid, 1 validation error or usage, 2 parse failure.
"""

from __future__ import annotations

import base64
import re
import struct
import sys
import urllib.parse
import xml.etree.ElementTree as ET
import zlib

MAX_BYTES = 32 * 1024 * 1024


class DrawioError(Exception):
    pass


def _read_bytes(path: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            data = fh.read(MAX_BYTES + 1)
    except OSError as exc:
        raise DrawioError(f"cannot read {path}: {exc}") from exc
    if len(data) > MAX_BYTES:
        raise DrawioError(f"{path} exceeds {MAX_BYTES} bytes; refusing")
    return data


def _no_dtd(data: bytes) -> None:
    head = data[:65536].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
        raise DrawioError("XML contains DOCTYPE/ENTITY; refusing (XXE hardening)")


def _decompress_body(text: str) -> str:
    """Decode one draw.io compressed <diagram> body to XML text."""
    try:
        raw = zlib.decompress(base64.b64decode(text, validate=True), -15)
    except (ValueError, zlib.error) as exc:
        raise DrawioError(f"cannot inflate diagram body: {exc}") from exc
    return urllib.parse.unquote(raw.decode("utf-8", "replace"))


def _compress_body(xml_text: str) -> str:
    raw = zlib.compress(urllib.parse.quote(xml_text, safe="").encode("utf-8"), 9)
    return base64.b64encode(raw).decode("ascii")


def _looks_like_xml(text: str) -> bool:
    stripped = text.strip()
    return stripped.startswith("<")


def _decode_mxfile(xml_text: str, compress: bool = False) -> str:
    """Given XML containing <mxfile>, expand/normalize compressed bodies."""
    _no_dtd(xml_text.encode("utf-8"))
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise DrawioError(f"XML parse error: {exc}") from exc

    for diagram in root.iter("diagram"):
        body = (diagram.text or "").strip()
        if body and not _looks_like_xml(body):
            diagram.text = ("\n" if not compress else "") + (
                _compress_body(_decompress_body(body)) if compress
                else _decompress_body(body)
            )
            if not compress:
                diagram.text = diagram.text + "\n"
    return ET.tostring(root, encoding="unicode")


def _svg_payload(text: str) -> str | None:
    """Extract the mxfile embedded in a .drawio.svg `content` attribute."""
    marker = 'content="'
    idx = text.find(marker)
    if idx == -1:
        return None
    end = text.find('"', idx + len(marker))
    if end == -1:
        return None
    import html

    return html.unescape(text[idx + len(marker):end])


def _png_payload(data: bytes) -> str | None:
    """Extract the URL-encoded mxfile from a .drawio.png zTXt chunk."""
    p = 8
    while p + 12 <= len(data):
        (length,) = struct.unpack(">I", data[p:p + 4])
        ctype = data[p + 4:p + 8]
        body = data[p + 8:p + 8 + length]
        if ctype == b"zTXt":
            keyword, _, rest = body.partition(b"\x00")
            if keyword in (b"mxGraphModel", b"mxfile") and rest:
                try:
                    return zlib.decompress(rest[1:]).decode("utf-8", "replace")
                except zlib.error as exc:
                    raise DrawioError(f"zTXt inflate failed: {exc}") from exc
        if ctype == b"IEND":
            break
        p += 12 + length
    return None


def load_document(path: str) -> str:
    """Return the full uncompressed mxfile XML for any supported file."""
    data = _read_bytes(path)
    lower = path.lower()

    if lower.endswith(".png") or data[:8] == b"\x89PNG\r\n\x1a\n":
        payload = _png_payload(data)
        if payload is None:
            raise DrawioError("no embedded draw.io diagram found in PNG")
        payload = urllib.parse.unquote(payload)
        if payload.lstrip().startswith("<"):
            return _decode_mxfile(payload)
        return _decode_mxfile(_decode_mxfile(payload))

    if lower.endswith(".svg") or b"<svg" in data[:2048]:
        text = data.decode("utf-8", "replace")
        payload = _svg_payload(text)
        if payload is None:
            raise DrawioError("no embedded draw.io diagram found in SVG")
        return _decode_mxfile(payload)

    return _decode_mxfile(data.decode("utf-8", "replace"))


def cmd_decode(path: str) -> int:
    sys.stdout.write(load_document(path))
    if not sys.stdout.isatty():
        pass
    return 0


def cmd_encode(path: str, out: str | None) -> int:
    xml_text = load_document(path)
    compressed = _decode_mxfile(xml_text, compress=True)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(compressed + "\n")
    else:
        sys.stdout.write(compressed + "\n")
    return 0


def cmd_validate(path: str) -> int:
    errors: list[str] = []
    doc = load_document(path)
    try:
        root = ET.fromstring(doc)
    except ET.ParseError as exc:
        print(f"ERROR: parse failure: {exc}")
        return 2

    models = list(root.iter("mxGraphModel"))
    if not models and root.tag != "mxGraphModel":
        print("ERROR: no <mxGraphModel> found")
        return 1
    if not models:
        models = [root]

    for mi, model in enumerate(models):
        tag = f"page {mi}"
        root_cells = model.find("./root")
        if root_cells is None:
            errors.append(f"{tag}: missing <root>")
            continue
        cells = list(root_cells)
        ids: set[str] = set()
        dups: set[str] = set()
        for cell in cells:
            cid = cell.get("id")
            if cid is None:
                errors.append(f"{tag}: cell without id (value={cell.get('value')!r})")
                continue
            if cid in ids:
                dups.add(cid)
            ids.add(cid)
        for cid in sorted(dups):
            errors.append(f"{tag}: duplicate id {cid!r}")
        if "0" not in ids:
            errors.append(f"{tag}: mandatory cell id=0 (root) missing")
        if "1" not in ids:
            errors.append(f"{tag}: mandatory cell id=1 (default layer) missing")

        for cell in cells:
            cid = cell.get("id")
            if cell.get("edge") == "1":
                if cell.find("mxGeometry") is None:
                    errors.append(f"{tag}: edge {cid!r} missing <mxGeometry> child")
                for attr in ("source", "target"):
                    ref = cell.get(attr)
                    if ref is not None and ref not in ids:
                        errors.append(
                            f"{tag}: edge {cid!r} {attr}={ref!r} references unknown id"
                        )
            if cell.get("vertex") == "1" and cell.find("mxGeometry") is None:
                errors.append(f"{tag}: vertex {cid!r} missing <mxGeometry> child")

    if errors:
        for err in errors:
            print(f"ERROR: {err}")
        print(f"INVALID: {len(errors)} problem(s) in {path}")
        return 1
    print(f"OK: {path} is well-formed and structurally valid")
    return 0


def cmd_info(path: str) -> int:
    doc = load_document(path)
    root = ET.fromstring(doc)
    diagrams = list(root.iter("diagram"))
    print(f"file:    {path}")
    print(f"format:  {'mxfile' if root.tag == 'mxfile' else root.tag}")
    print(f"pages:   {len(diagrams) or 1}")
    models = list(root.iter("mxGraphModel")) or [root]
    for i, model in enumerate(models):
        cells = list(model.iter("mxCell"))
        verts = sum(1 for c in cells if c.get("vertex") == "1")
        edges = sum(1 for c in cells if c.get("edge") == "1")
        name = diagrams[i].get("name") if i < len(diagrams) else "default"
        print(f"  page {i} ({name!r}): {verts} vertices, {edges} edges")
    return 0


_DRAWIO_WARNING_RE = re.compile(
    r'<switch><g requiredFeatures="http://www\.w3\.org/TR/SVG11/feature#Extensibility"/>'
    r'<a[^>]*drawio\.com/doc/faq/svg-export-text-problems[^>]*>.*?</a></switch>',
    re.DOTALL,
)


def _flatten_light_dark(text: str) -> str:
    """Replace light-dark(a, b) with its light value `a` (paren-aware)."""
    out: list[str] = []
    i = 0
    marker = "light-dark("
    while True:
        j = text.find(marker, i)
        if j == -1:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = j + len(marker)
        depth = 1
        args: list[str] = []
        cur: list[str] = []
        while k < len(text) and depth > 0:
            ch = text[k]
            if ch == "(":
                depth += 1
                cur.append(ch)
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
                cur.append(ch)
            elif ch == "," and depth == 1:
                args.append("".join(cur))
                cur = []
            else:
                cur.append(ch)
            k += 1
        args.append("".join(cur))
        out.append(args[0].strip() if args else "")
        i = k + 1
    return "".join(out)


def cmd_flatten_svg(path: str, out: str | None) -> int:
    data = _read_bytes(path).decode("utf-8", "replace")
    if "<svg" not in data[:4096]:
        raise DrawioError(f"{path} does not look like an SVG")
    text = data.replace("color-scheme: light dark", "color-scheme: light")
    text = text.replace("color-scheme:light dark", "color-scheme:light")
    text = _flatten_light_dark(text)
    text = _DRAWIO_WARNING_RE.sub("", text)
    dest = out or path
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"OK: flattened {dest}")
    return 0


USAGE = __doc__ or ""


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if len(argv) > 1 else 1
    cmd = argv[1]
    try:
        if cmd in ("decode", "extract", "cat"):
            if len(argv) != 3:
                print("usage: drawio-xml.py decode <file>", file=sys.stderr)
                return 1
            return cmd_decode(argv[2])
        if cmd == "encode":
            if len(argv) not in (3, 4):
                print("usage: drawio-xml.py encode <in> [out]", file=sys.stderr)
                return 1
            return cmd_encode(argv[2], argv[3] if len(argv) == 4 else None)
        if cmd == "validate":
            if len(argv) != 3:
                print("usage: drawio-xml.py validate <file>", file=sys.stderr)
                return 1
            return cmd_validate(argv[2])
        if cmd == "info":
            if len(argv) != 3:
                print("usage: drawio-xml.py info <file>", file=sys.stderr)
                return 1
            return cmd_info(argv[2])
        if cmd in ("flatten-svg", "flatten"):
            if len(argv) not in (3, 4):
                print("usage: drawio-xml.py flatten-svg <file> [out]", file=sys.stderr)
                return 1
            return cmd_flatten_svg(argv[2], argv[3] if len(argv) == 4 else None)
    except DrawioError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(f"ERROR: unknown subcommand {cmd!r}\n{USAGE}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
