"""Output shaping helpers for python runtime tool."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

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
MAX_TABLE_HTML_CHARS = 100_000
MAX_TOTAL_TABLE_HTML_CHARS = 250_000
MAX_TABLE_NAME_CHARS = 200
_TABLE_ROW_RE = re.compile(r"(<tr\b.*?</tr>)", re.IGNORECASE | re.DOTALL)


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


def _image_to_attachment_bytes(image_path: Path) -> tuple[bytes | None, int]:
    """Read one COMPLETE chart image within the per-image byte budget.

    Returns ``(None, size)`` when the image is missing, unreadable, a link,
    or over budget — the whole image is omitted, never truncated (WIDE-021:
    encodings must stay complete).
    """
    try:
        image_stat = image_path.lstat()
    except OSError:
        return None, 0
    if not image_path.is_file() or image_path.is_symlink():
        return None, 0
    if image_stat.st_size > MAX_IMAGE_BYTES:
        return None, int(image_stat.st_size)
    try:
        with image_path.open("rb") as handle:
            image_bytes = handle.read(MAX_IMAGE_BYTES + 1)
    except OSError:
        return None, 0
    if len(image_bytes) > MAX_IMAGE_BYTES:
        return None, len(image_bytes)
    return image_bytes, len(image_bytes)


def format_python_output(  # noqa: PLR0915 - single output-shaping seam.
    raw_payload: dict[str, Any],
    work_dir: Path,
) -> tuple[dict[str, object], tuple[dict[str, Any], ...]]:
    """Shape the model-visible payload plus the typed chart attachments.

    The returned payload NEVER embeds base64 — ``images`` carries safe
    attachment refs; full bytes ride the trusted-attachment side channel.
    """
    stdout, stdout_truncated = _truncate(raw_payload.get("stdout", ""))
    stderr, stderr_truncated = _truncate(raw_payload.get("stderr", ""))
    raw_images = raw_payload.get("images", [])
    image_names = raw_images if isinstance(raw_images, list) else []

    images: list[dict[str, object]] = []
    attachments: list[dict[str, Any]] = []
    images_truncated = False
    total_image_bytes = 0
    for image_name in image_names[:MAX_IMAGES]:
        if not isinstance(image_name, str) or not image_name.strip():
            continue
        image_bytes, byte_count = _image_to_attachment_bytes(work_dir / image_name)
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
    if len(image_names) > MAX_IMAGES:
        images_truncated = True

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
    if isinstance(error, dict):
        traceback_text, traceback_truncated = _truncate(error.get("traceback", ""))
        normalized_error = {
            "type": str(error.get("type", "")),
            "message": str(error.get("message", "")),
            "traceback": traceback_text,
        }
        tables_truncated = tables_truncated or traceback_truncated

    last_expr_repr_text, expr_truncated = _truncate(raw_payload.get("last_expr_repr", ""))
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
            or expr_truncated
        ),
    }
    return payload, tuple(attachments)
