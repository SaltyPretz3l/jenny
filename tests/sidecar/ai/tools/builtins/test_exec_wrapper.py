"""In-process tests for the Python-runtime isolated exec wrapper.

`_exec_wrapper.main` is normally invoked as a subprocess entrypoint inside the
python_runtime sandbox venv, so the existing tests (which spawn it) never
attribute coverage to it -- and matplotlib (which it imports at module load) is
only present in that runtime venv, not the sidecar test env. These tests install
a faithful fake matplotlib (the same pattern the existing surrogate-stripping
test uses), re-import the wrapper fresh, and drive `main()` plus every helper
in-process so the stdout/expr/error/figure/table paths are actually exercised.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import pytest

_WRAPPER_MODULE = "sidecar.ai.tools.builtins.python_runtime._exec_wrapper"


class _FakeFigure:
    def __init__(self, num: int) -> None:
        self.num = num

    def savefig(self, path, **_kwargs) -> None:  # noqa: ANN001
        # Write a placeholder so the wrapper's "did a file land?" logic is real.
        Path(path).write_bytes(b"\x89PNG\r\n\x1a\n")

    def get_size_inches(self) -> tuple[float, float]:
        return 1.0, 1.0


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Install a fake matplotlib, re-import the wrapper fresh, yield both."""
    state: dict[str, list[int]] = {"fignums": []}

    fake_mpl = types.ModuleType("matplotlib")
    fake_mpl.use = lambda *_a, **_k: None  # type: ignore[attr-defined]
    fake_plt = types.ModuleType("matplotlib.pyplot")
    fake_plt.get_fignums = lambda: list(state["fignums"])  # type: ignore[attr-defined]
    fake_plt.figure = lambda num=None, *_a, **_k: _FakeFigure(num)  # type: ignore[attr-defined]
    fake_plt.close = lambda *_a, **_k: state["fignums"].clear()  # type: ignore[attr-defined]
    fake_plt.plot = lambda *_a, **_k: state["fignums"].append(len(state["fignums"]))  # type: ignore[attr-defined]
    fake_plt.show = lambda *_a, **_k: None  # type: ignore[attr-defined]  # wrapper overrides this on import
    fake_mpl.pyplot = fake_plt  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "matplotlib", fake_mpl)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", fake_plt)
    monkeypatch.delitem(sys.modules, _WRAPPER_MODULE, raising=False)
    wrapper = importlib.import_module(_WRAPPER_MODULE)

    yield types.SimpleNamespace(wrapper=wrapper, state=state, tmp_path=tmp_path)

    # Pop the fake-bound module so a later importer re-imports against its own
    # matplotlib substitute rather than this fixture's now-removed fake.
    sys.modules.pop(_WRAPPER_MODULE, None)


def _run_main(env, source: str) -> tuple[int, dict]:
    script = env.tmp_path / "script.py"
    script.write_text(source, encoding="utf-8")
    result = env.tmp_path / "result.json"
    out_dir = env.tmp_path / "out"
    exit_code = env.wrapper.main(["_prog", str(script), str(result), str(out_dir)])
    payload = json.loads(result.read_text(encoding="utf-8"))
    return exit_code, payload


# --- main(): stdout + trailing-expression repr --------------------------------

def test_main_captures_stdout_and_last_expression(env) -> None:
    exit_code, payload = _run_main(env, "print('hello world')\n1 + 2\n")

    assert exit_code == 0
    assert payload["stdout"] == "hello world\n"
    assert payload["stderr"] == ""
    assert payload["error"] is None
    assert payload["last_expr_repr"] == repr(3)
    assert payload["images"] == []
    assert payload["tables"] == []


def test_main_statement_only_has_no_last_expression(env) -> None:
    exit_code, payload = _run_main(env, "x = 41\ny = x + 1\n")

    assert exit_code == 0
    assert payload["last_expr_repr"] is None
    assert payload["error"] is None


def test_child_stdout_capture_is_bounded_before_result_serialization(env) -> None:
    capture = env.wrapper._BoundedTextCapture(max_chars=8)  # noqa: SLF001

    assert capture.write("secret-output") == len("secret-output")
    assert capture.total_chars == len("secret-output")
    assert capture.truncated is True
    assert capture.getvalue().startswith("secret-o")
    assert "truncated by python runtime child budget" in capture.getvalue()


def test_main_trailing_expression_evaluating_to_none_is_omitted(env) -> None:
    # Final line is an Expr whose value is None -> exercises `if expr_value is not None`.
    exit_code, payload = _run_main(env, "print('only stdout')\n")

    assert exit_code == 0
    assert payload["stdout"] == "only stdout\n"
    assert payload["last_expr_repr"] is None


# --- main(): error path -------------------------------------------------------

def test_main_error_path_returns_structured_payload(env) -> None:
    exit_code, payload = _run_main(env, "raise ValueError('boom')\n")

    assert exit_code == 1
    error = payload["error"]
    assert error["type"] == "ValueError"
    assert error["message"] == "boom"
    assert "Traceback (most recent call last):" in error["traceback"]
    assert "ValueError: boom" in error["traceback"]
    assert payload["last_expr_repr"] is None


# --- main(): matplotlib figure capture ---------------------------------------

def test_main_captures_figure_on_show(env) -> None:
    source = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()\n"
    exit_code, payload = _run_main(env, source)

    assert exit_code == 0
    assert payload["images"] == ["figure_0.png"]
    assert (env.tmp_path / "out" / "figure_0.png").is_file()


def test_main_captures_dangling_figure_in_finally(env) -> None:
    # No plt.show(): the open figure is swept up by main()'s finally block.
    source = "import matplotlib.pyplot as plt\nplt.plot([3, 1, 2])\n"
    exit_code, payload = _run_main(env, source)

    assert exit_code == 0
    assert payload["images"] == ["figure_0.png"]
    assert (env.tmp_path / "out" / "figure_0.png").is_file()


def test_main_preserves_shown_then_dangling_figure_order(env) -> None:
    source = (
        "import matplotlib.pyplot as plt\n"
        "plt.plot([1, 2, 3])\n"
        "plt.show()\n"
        "plt.plot([3, 2, 1])\n"
    )

    exit_code, payload = _run_main(env, source)

    assert exit_code == 0
    assert payload["images"] == ["figure_0.png", "figure_1.png"]


# --- main(): pandas table collection -----------------------------------------

def test_main_collects_dataframe_tables(env) -> None:
    source = "import pandas as pd\nframe = pd.DataFrame({'a': [1, 2], 'b': [3, 4]})\n"
    exit_code, payload = _run_main(env, source)

    assert exit_code == 0
    tables = payload["tables"]
    assert len(tables) == 1
    assert tables[0]["name"] == "frame"
    assert tables[0]["shape"] == [2, 2]
    assert "<table" in tables[0]["html"]


def test_child_table_collection_caps_count_columns_cells_and_aggregate(env) -> None:
    pd = pytest.importorskip("pandas")
    frame = pd.DataFrame(
        [["x" * 10_000] * (env.wrapper._MAX_TABLE_COLUMNS + 4)],  # noqa: SLF001
    )
    namespace = {f"table_{index}": frame for index in range(20)}

    tables = env.wrapper._collect_tables(namespace)  # noqa: SLF001

    assert len(tables) == env.wrapper._MAX_TABLES  # noqa: SLF001
    assert sum(len(str(table["html"])) for table in tables) <= (
        env.wrapper._MAX_TOTAL_TABLE_HTML_CHARS  # noqa: SLF001
    )
    assert "x" * (env.wrapper._MAX_TABLE_CELL_CHARS + 1) not in str(tables)  # noqa: SLF001


# --- helper-level coverage of edge branches ----------------------------------

def test_collect_tables_skips_private_and_non_dataframe(env) -> None:
    import pandas as pd  # type: ignore

    frame = pd.DataFrame({"a": [1]})
    namespace = {"_hidden": frame, "scalar": 5, "visible": frame}

    tables = env.wrapper._collect_tables(namespace)  # noqa: SLF001

    assert [t["name"] for t in tables] == ["visible"]


def test_collect_tables_without_pandas_returns_empty(env, monkeypatch: pytest.MonkeyPatch) -> None:
    # Make `import pandas` fail inside the helper to exercise the except branch.
    monkeypatch.setitem(sys.modules, "pandas", None)

    assert env.wrapper._collect_tables({"frame": object()}) == []  # noqa: SLF001


def test_compile_user_code_separates_trailing_expression(env) -> None:
    exec_code, expr_code = env.wrapper._compile_user_code("x = 10\nx * 2\n")  # noqa: SLF001

    namespace: dict[str, object] = {}
    exec(exec_code, namespace, namespace)
    assert expr_code is not None
    assert eval(expr_code, namespace, namespace) == 20


def test_compile_user_code_no_trailing_expression(env) -> None:
    exec_code, expr_code = env.wrapper._compile_user_code("x = 10\n")  # noqa: SLF001

    assert expr_code is None
    namespace: dict[str, object] = {}
    exec(exec_code, namespace, namespace)
    assert namespace["x"] == 10


def test_compile_user_code_empty_source(env) -> None:
    exec_code, expr_code = env.wrapper._compile_user_code("")  # noqa: SLF001

    assert expr_code is None
    exec(exec_code, {}, {})  # must not raise


def test_format_traceback_without_user_frames_returns_full_trace(env) -> None:
    try:
        raise RuntimeError("native boom")
    except RuntimeError as error:  # noqa: BLE001
        formatted = env.wrapper._format_traceback(error)  # noqa: SLF001

    # No frame has filename "<analysis>", so the full default formatting is used.
    assert "RuntimeError: native boom" in formatted


def test_safe_json_dumps_replaces_lone_surrogate(env) -> None:
    serialized = env.wrapper._safe_json_dumps({"k": "bad\udc8fvalue"})  # noqa: SLF001

    assert "\udc8f" not in serialized
    assert json.loads(serialized) == {"k": "bad�value"}
