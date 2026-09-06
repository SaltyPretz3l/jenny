"""Isolated execution wrapper for the Python runtime tool."""

from __future__ import annotations

import ast
import json
import re
import sys
import traceback
from pathlib import Path
from types import CodeType
from typing import Any

import matplotlib  # type: ignore[import-not-found]

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # type: ignore[import-not-found]

PYTHON_RESULT_SCHEMA_VERSION = 1

_FIGURE_COUNTER = 0
_SAVED_IMAGES: list[str] = []
_OUTPUT_DIR: Path | None = None
_MAX_CAPTURE_CHARS = 512 * 1024
_MAX_CAPTURE_MARKER = "\n...[truncated by python runtime child budget]"
_MAX_IMAGES = 4
_MAX_IMAGE_PIXELS = 16_000_000
_MAX_TABLES = 8
_MAX_TABLE_ROWS = 50
_MAX_TABLE_COLUMNS = 32
_MAX_TABLE_CELL_CHARS = 512
_MAX_TABLE_HTML_CHARS = 100_000
_MAX_TOTAL_TABLE_HTML_CHARS = 500_000
_MAX_TABLE_NAME_CHARS = 200
_MAX_ERROR_MESSAGE_CHARS = 4_000
_MAX_TRACEBACK_CHARS = 50_000
_MAX_EXPRESSION_CHARS = 20_000
_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _strip_surrogates(text: str) -> str:
    # This wrapper runs under the isolated embeddable interpreter and must not
    # import the sidecar package. Keep the tiny UTF-8 safety transform local.
    return _SURROGATE_RE.sub("\ufffd", text)


class _BoundedTextCapture:
    def __init__(self, max_chars: int = _MAX_CAPTURE_CHARS) -> None:
        self._max_chars = max(1, int(max_chars))
        self._parts: list[str] = []
        self._captured_chars = 0
        self.total_chars = 0
        self.truncated = False

    def write(self, value: object) -> int:
        text = str(value)
        self.total_chars += len(text)
        remaining = max(0, self._max_chars - self._captured_chars)
        if remaining:
            retained = text[:remaining]
            self._parts.append(retained)
            self._captured_chars += len(retained)
        if len(text) > remaining:
            self.truncated = True
        return len(text)

    def flush(self) -> None:
        return None

    def getvalue(self) -> str:
        value = "".join(self._parts)
        return f"{value}{_MAX_CAPTURE_MARKER}" if self.truncated else value


def _capture_figures(output_dir: Path) -> list[str]:
    global _FIGURE_COUNTER
    saved: list[str] = []
    for fig_num in list(plt.get_fignums()):
        fig = plt.figure(fig_num)
        width, height = fig.get_size_inches()
        pixel_count = max(0, int(width * 150)) * max(0, int(height * 150))
        if _FIGURE_COUNTER >= _MAX_IMAGES or pixel_count > _MAX_IMAGE_PIXELS:
            plt.close(fig)
            continue
        file_name = f"figure_{_FIGURE_COUNTER}.png"
        fig.savefig(output_dir / file_name, dpi=150, bbox_inches="tight")
        saved.append(file_name)
        _FIGURE_COUNTER += 1
    plt.close("all")
    return saved


def _patched_show(*_args, **_kwargs) -> None:
    if _OUTPUT_DIR is not None:
        _SAVED_IMAGES.extend(_capture_figures(_OUTPUT_DIR))


plt.show = _patched_show


def _compile_user_code(source: str) -> tuple[CodeType, CodeType | None]:
    tree = ast.parse(source, filename="<analysis>", mode="exec")
    expr_code: CodeType | None = None
    last_statement = tree.body[-1] if tree.body else None
    if isinstance(last_statement, ast.Expr):
        tree.body = tree.body[:-1]
        expr = ast.Expression(last_statement.value)
        ast.fix_missing_locations(expr)
        expr_code = compile(expr, "<analysis>", "eval")
    ast.fix_missing_locations(tree)
    exec_code = compile(tree, "<analysis>", "exec")
    return exec_code, expr_code


def _format_traceback(error: BaseException) -> str:
    extracted = traceback.extract_tb(error.__traceback__)
    user_frames = [frame for frame in extracted if frame.filename == "<analysis>"]
    if not user_frames:
        return "".join(traceback.format_exception(type(error), error, error.__traceback__))
    formatted = ["Traceback (most recent call last):\n"]
    formatted.extend(traceback.format_list(user_frames))
    formatted.extend(traceback.format_exception_only(type(error), error))
    return "".join(formatted)


def _collect_tables(namespace: dict[str, Any]) -> list[dict[str, object]]:
    try:
        import pandas as pd  # type: ignore
    except Exception:
        return []

    tables: list[dict[str, object]] = []
    total_html_chars = 0
    for name, value in namespace.items():
        if name.startswith("_") or not isinstance(value, pd.DataFrame):
            continue
        if len(tables) >= _MAX_TABLES or total_html_chars >= _MAX_TOTAL_TABLE_HTML_CHARS:
            break
        preview = value.iloc[:_MAX_TABLE_ROWS, :_MAX_TABLE_COLUMNS]
        safe_rows = [
            [_bounded_cell(cell) for cell in row]
            for row in preview.itertuples(index=False, name=None)
        ]
        safe_columns = [
            _bounded_cell(column) for column in list(preview.columns)
        ]
        safe_preview = pd.DataFrame(safe_rows, columns=safe_columns)
        html = safe_preview.to_html(index=False, escape=True)
        remaining = _MAX_TOTAL_TABLE_HTML_CHARS - total_html_chars
        if len(html) > min(_MAX_TABLE_HTML_CHARS, remaining):
            html = "<p>Table preview omitted because it exceeded the child output budget.</p>"
        total_html_chars += len(html)
        tables.append(
            {
                "name": str(name)[:_MAX_TABLE_NAME_CHARS],
                "html": html,
                "shape": [int(value.shape[0]), int(value.shape[1])],
            }
        )
    return tables


def _bounded_cell(value: object) -> str:
    try:
        text = str(value)
    except Exception:  # noqa: BLE001 - hostile cell repr must not fail execution.
        return f"<{type(value).__name__}>"
    return text[:_MAX_TABLE_CELL_CHARS]


def _bounded_text(value: object, max_chars: int) -> str:
    text = str(value or "")
    return text[: max(1, int(max_chars))]


def _safe_json_dumps(payload: object) -> str:
    return _strip_surrogates(json.dumps(payload, ensure_ascii=False))


def main(argv: list[str]) -> int:
    global _OUTPUT_DIR
    script_path = Path(argv[1])
    result_path = Path(argv[2])
    output_dir = Path(argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)
    _OUTPUT_DIR = output_dir

    stdout_buffer = _BoundedTextCapture()
    stderr_buffer = _BoundedTextCapture()
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = stdout_buffer
    sys.stderr = stderr_buffer

    namespace: dict[str, Any] = {"__builtins__": __builtins__, "__name__": "__main__"}
    images: list[str] = []
    last_expr_repr = None
    error_payload = None
    exit_code = 0

    try:
        source = script_path.read_text(encoding="utf-8")
        exec_code, expr_code = _compile_user_code(source)
        exec(exec_code, namespace, namespace)
        if expr_code is not None:
            expr_value = eval(expr_code, namespace, namespace)
            if expr_value is not None:
                last_expr_repr = _bounded_text(repr(expr_value), _MAX_EXPRESSION_CHARS)
    except Exception as error:  # noqa: BLE001
        exit_code = 1
        error_payload = {
            "type": type(error).__name__,
            "message": _bounded_text(error, _MAX_ERROR_MESSAGE_CHARS),
            "traceback": _bounded_text(_format_traceback(error), _MAX_TRACEBACK_CHARS),
        }
    finally:
        if plt.get_fignums():
            images.extend(_capture_figures(output_dir))
        sys.stdout = original_stdout
        sys.stderr = original_stderr

    if _SAVED_IMAGES:
        images = [*_SAVED_IMAGES, *images]

    payload = {
        "schema_version": PYTHON_RESULT_SCHEMA_VERSION,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "error": error_payload,
        "images": images,
        "tables": _collect_tables(namespace),
        "last_expr_repr": last_expr_repr,
    }
    result_path.write_text(_safe_json_dumps(payload), encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
