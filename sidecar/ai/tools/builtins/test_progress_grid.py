"""Grid construction for live test-run progress (pure functions, no I/O)."""

from __future__ import annotations

import posixpath
from bisect import bisect_left
from functools import lru_cache

from sidecar.ai.tools.builtins.test_progress_runners import clean

MAX_CELLS = 2500
MIN_FILE_GRID = 12
SMALL_CELLS = 1000

Grid = dict[str, object]


def worst_state(chunk: str) -> str:
    """Collapse a group of file states into one cell state."""
    if "f" in chunk:
        return "f"
    if not chunk.strip("-"):
        return "-"
    if not chunk.strip("s"):
        return "s"
    if not chunk.strip("ps"):
        return "p"
    return "r"


@lru_cache(maxsize=4096)
def _clean_folder(folder: str) -> str:
    return clean(folder)


def _group_label(labels: list[str]) -> str:
    parts = [posixpath.dirname(label).split("/") for label in labels]
    common: list[str] = []
    for column in zip(*parts, strict=False):
        if len(set(column)) != 1:
            break
        common.append(column[0])
    folder = "/".join(part for part in common if part) or "."
    # Sanitize only the folder: the sanitizer would flatten the ellipsis.
    return f"{_clean_folder(folder)}/… · {len(labels)} files"


def file_grid(
    states: str, labels: list[str], *, labels_from: int = 0
) -> tuple[Grid, list[str | None]]:
    """One cell per file (or per ``k`` neighbouring files past 2,500).

    ``labels`` may be shorter than ``states`` (node safe runner: labels exist only for finished
    files); a cell's label is ``None`` until every file in it has one. Grouped cells before
    ``labels_from`` are not labelled (the caller already sent them), so a snapshot only pays for
    the labels it will carry.
    """
    files = len(states)
    group = max(1, -(-files // MAX_CELLS))
    if group == 1:
        cell_states = states
        cell_labels: list[str | None] = list(labels[:files])
        cell_labels.extend([None] * (files - len(cell_labels)))
    else:
        cells = -(-files // group)
        cell_states = "".join(
            worst_state(states[i * group : (i + 1) * group]) for i in range(cells)
        )
        cell_labels = []
        for i in range(cells):
            end = min((i + 1) * group, files)
            known = i >= labels_from and len(labels) >= end
            cell_labels.append(_group_label(labels[i * group : end]) if known else None)
    count = len(cell_states)
    px = 6 if count <= SMALL_CELLS and group == 1 else 4
    return {"count": count, "group": group, "px": px, "states": cell_states}, cell_labels


def order_grid(total: int, done: int, fail_positions: list[int], *, final: bool) -> Grid | None:
    """Cells over finished tests in completion order (``fail_positions`` is ascending)."""
    if total <= 0:
        return None
    count = min(total, SMALL_CELLS)
    done = max(0, min(done, total))
    chars: list[str] = []
    for i in range(count):
        low, high = i * total // count, (i + 1) * total // count
        index = bisect_left(fail_positions, low)
        failed = index < len(fail_positions) and fail_positions[index] < high
        if failed:
            chars.append("f")
        elif high <= done:
            chars.append("p")
        elif low <= done < high:
            chars.append("p" if final else "r")
        else:
            chars.append("-")
    return {"count": count, "group": 1, "px": 6, "states": "".join(chars)}
