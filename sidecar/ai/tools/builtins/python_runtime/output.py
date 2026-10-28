"""Output shaping helpers for python runtime tool."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from sidecar.ai.tools.error_paths import PathKeeper, error_path_keeper, redact_error_paths
from sidecar.ai.tools.trusted_attachments import (
    ATTACHMENT_KIND_CHART,
    TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES,
    build_trusted_attachment,
)

MAX_OUTPUT_CHARS = 20_000
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 1 * 1024 * 1024
# Aggregate chart-image budget per execution. Matches the typed-attachment
# per-result aggregate cap (WIDE-019) so everything produced here is
# admissible downstream.
MAX_TOTAL_IMAGE_BYTES = TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES
MAX_TABLES = 8
MAX_TABLE_ROWS = 50
# The child wrapper (_exec_wrapper.py) carries the same table budgets; it runs
# in the managed runtime and imports matplotlib, so it cannot import these.
MAX_TABLE_HTML_CHARS = 100_000
MAX_TOTAL_TABLE_HTML_CHARS = 250_000
MAX_TABLE_NAME_CHARS = 200
_TABLE_ROW_RE = re.compile(r"(<tr\b.*?</tr>)", re.IGNORECASE | re.DOTALL)
# Only names the wrapper itself writes; anything else in the payload is refused.
_IMAGE_NAME_RE = re.compile(r"figure_\d+\.png")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# A URL is not a filesystem path; keep it out of path redaction so printed
# links survive. file: URLs carry local paths and stay subject to redaction.
_URL_RE = re.compile(r"\b(?!(?i:file):)[A-Za-z][A-Za-z0-9+.\-]*://[^\s\"'<>]+")


def _redact_output_paths(text: str, keep: PathKeeper) -> str:
    """Path-redact child output text (HB-017) without mangling URLs."""
    parts: list[str] = []
    last = 0
    for match in _URL_RE.finditer(text):
        parts.append(redact_error_paths(text[last : match.start()], keep=keep))
        parts.append(match.group(0))
        last = match.end()
    parts.append(redact_error_paths(text[last:], keep=keep))
    return "".join(parts)


def _truncate(value: Any) -> tuple[str, bool]:
    text = str(value or "")
    if len(text) <= MAX_OUTPUT_CHARS:
        return text, False
    return f"{text[:MAX_OUTPUT_CHARS]}\n...[truncated]", True


def _truncate_table_html(html: str) -> tuple[str, bool]:
    rows = _TABLE_ROW_RE.findall(html)
    if len(rows) <= MAX_TABLE_ROWS + 1:
        return html, False
    rebuilt = html
    for row in rows[MAX_TABLE_ROWS + 1 :]:
        rebuilt = rebuilt.replace(row, "", 1)
    if "</table>" in rebuilt:
        rebuilt = rebuilt.replace("</table>", "<caption>...[truncated]</caption></table>", 1)
    return rebuilt, True


def _contained_image_path(work_dir: Path, image_name: str) -> Path | None:
    """Resolve a wrapper-reported figure name strictly inside ``work_dir``."""
    if not _IMAGE_NAME_RE.fullmatch(image_name):
        return None
    try:
        root = work_dir.resolve()
        candidate = (work_dir / image_name).resolve()
    except (OSError, ValueError):
        return None
    if not candidate.is_relative_to(root) or candidate.parent != root:
        return None
    return work_dir / image_name


def _image_to_attachment_bytes(image_path: Path) -> tuple[bytes | None, int]:
    """Read one COMPLETE chart image within the per-image byte budget.

    Returns ``(None, size)`` when the image is missing, unreadable, a link,
    or over budget — the whole image is omitted, never truncated (WIDE-021:
    encodings must stay complete).
    """
    try:
        image_stat = image_path.lstat()
        if not image_path.is_file() or image_path.is_symlink():
            return None, 0
        if image_stat.st_size > MAX_IMAGE_BYTES:
            return None, int(image_stat.st_size)
        with image_path.open("rb") as handle:
            image_bytes = handle.read(MAX_IMAGE_BYTES + 1)
    except (OSError, ValueError):
        return None, 0
    if len(image_bytes) > MAX_IMAGE_BYTES:
        return None, len(image_bytes)
    if not image_bytes.startswith(_PNG_SIGNATURE):
        return None, 0
    return image_bytes, len(image_bytes)


def _chart_attachments(
    image_names: list[Any], work_dir: Path
) -> tuple[list[dict[str, object]], list[dict[str, Any]], bool]:
    """Typed chart attachments plus their model-visible refs for each figure."""
    images: list[dict[str, object]] = []
    attachments: list[dict[str, Any]] = []
    images_truncated = len(image_names) > MAX_IMAGES
    total_image_bytes = 0
    for image_name in image_names[:MAX_IMAGES]:
        if not isinstance(image_name, str) or not image_name.strip():
            continue
        image_path = _contained_image_path(work_dir, image_name)
        image_bytes, byte_count = (
            (None, 0) if image_path is None else _image_to_attachment_bytes(image_path)
        )
        if image_bytes is None:
            images_truncated = True
            continue
        if total_image_bytes + byte_count > MAX_TOTAL_IMAGE_BYTES:
            images_truncated = True
            break
        total_image_bytes += byte_count
        attachment = build_trusted_attachment(
            kind=ATTACHMENT_KIND_CHART,
            mime_type="image/png",
            data=image_bytes,
            source_tool="python_execute",
        )
        attachments.append(attachment)
        images.append(
            {
                "id": attachment["id"],
                "mime_type": attachment["mime_type"],
                "byte_length": attachment["byte_length"],
            }
        )
    return images, attachments, images_truncated


def format_python_output(
    raw_payload: dict[str, Any],
    work_dir: Path,
    *,
    workspace_root: Path | None = None,
    arguments: object = None,
) -> tuple[dict[str, object], tuple[dict[str, Any], ...]]:
    """Shape the model-visible payload plus the typed chart attachments.

    The returned payload NEVER embeds base64 — ``images`` carries safe
    attachment refs; full bytes ride the trusted-attachment side channel.
    Child text is untrusted: absolute paths outside the bound workspace and
    the call's own arguments become ``<path>`` before truncation.
    """
    keep = error_path_keeper(arguments=arguments, workspace_root=workspace_root)

    def _shaped(value: Any) -> tuple[str, bool]:
        return _truncate(_redact_output_paths(str(value or ""), keep))

    stdout, stdout_truncated = _shaped(raw_payload.get("stdout", ""))
    stderr, stderr_truncated = _shaped(raw_payload.get("stderr", ""))
    raw_images = raw_payload.get("images", [])
    images, attachments, images_truncated = _chart_attachments(
        raw_images if isinstance(raw_images, list) else [], work_dir
    )

    tables: list[dict[str, object]] = []
    tables_truncated = False
    raw_tables = raw_payload.get("tables", [])
    table_values = raw_tables if isinstance(raw_tables, list) else []
    total_table_html_chars = 0
    for table in table_values[:MAX_TABLES]:
        if not isinstance(table, dict):
            continue
        html = str(table.get("html", ""))
        remaining_chars = max(0, MAX_TOTAL_TABLE_HTML_CHARS - total_table_html_chars)
        html_limit = min(MAX_TABLE_HTML_CHARS, remaining_chars)
        html_pretruncated = len(html) > html_limit
        html = html[:html_limit]
        trimmed_html, did_truncate = _truncate_table_html(html)
        total_table_html_chars += len(trimmed_html)
        tables_truncated = tables_truncated or html_pretruncated or did_truncate
        tables.append(
            {
                "name": str(table.get("name", ""))[:MAX_TABLE_NAME_CHARS],
                "html": trimmed_html,
                "shape": list(table.get("shape", []))[:2]
                if isinstance(table.get("shape"), (list, tuple))
                else [],
            }
        )
        if remaining_chars <= len(trimmed_html):
            break
    if len(table_values) > len(tables):
        tables_truncated = True

    error = raw_payload.get("error")
    normalized_error = None
    traceback_truncated = False
    if isinstance(error, dict):
        traceback_text, traceback_truncated = _shaped(error.get("traceback", ""))
        normalized_error = {
            "type": str(error.get("type", "")),
            "message": _redact_output_paths(str(error.get("message", "")), keep),
            "traceback": traceback_text,
        }

    last_expr_repr_text, expr_truncated = _shaped(raw_payload.get("last_expr_repr", ""))
    last_expr_repr: str | None = last_expr_repr_text or None

    payload: dict[str, object] = {
        "stdout": stdout,
        "stderr": stderr,
        "error": normalized_error,
        "images": images,
        "tables": tables,
        "last_expr_repr": last_expr_repr,
        "truncated": bool(
            stdout_truncated
            or stderr_truncated
            or images_truncated
            or tables_truncated
            or traceback_truncated
            or expr_truncated
        ),
    }
    return payload, tuple(attachments)
