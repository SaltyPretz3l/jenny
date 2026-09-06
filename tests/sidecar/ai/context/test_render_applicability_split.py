"""Red-first contract for the W3 Executable Tools render split.

Applicable-but-blocked tools are OFFERED, so the model will try them —
pre-stating the failure and its fix is a pure win (the 242-second surprise
becomes an informed choice). Unavailable tools stay unlisted: a model shown a
named capability tends to attempt it.
"""

from __future__ import annotations

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.builder_shared import RuntimeToolStatus


def _status(
    name: str,
    *,
    available: bool = True,
    applicable: bool = True,
    unmet: tuple[str, ...] = (),
) -> RuntimeToolStatus:
    return RuntimeToolStatus(
        name=name,
        display_name=name,
        available=available,
        description=f"{name} does things",
        applicable=applicable,
        unmet_preconditions=unmet,
    )


def _render(statuses: list[RuntimeToolStatus]) -> str:
    return ContextBuilder._render_executable_tools(statuses)


def test_applicable_tools_render_under_available_now() -> None:
    rendered = _render([_status("read_file")])
    assert "Available now:" in rendered
    assert "- `read_file`" in rendered
    assert "will fail until fixed" not in rendered


def test_blocked_tools_render_in_the_second_group_with_reason_and_fix() -> None:
    rendered = _render(
        [
            _status("read_file"),
            _status("git_status", applicable=False, unmet=("git_repo",)),
        ]
    )
    now_index = rendered.index("Available now:")
    blocked_index = rendered.index("Available, but will fail until fixed:")
    assert now_index < blocked_index
    blocked_section = rendered[blocked_index:]
    assert "- `git_status`" in blocked_section
    assert "git" in blocked_section.lower()
    assert "Fix:" in blocked_section
    # The blocked entry must not ALSO render as available-now.
    now_section = rendered[now_index:blocked_index]
    assert "`git_status`" not in now_section


def test_unavailable_tools_stay_unlisted() -> None:
    rendered = _render(
        [
            _status("read_file"),
            _status("hidden_tool", available=False, applicable=False, unmet=("git_repo",)),
        ]
    )
    assert "hidden_tool" not in rendered
    assert "will fail until fixed" not in rendered


def test_all_blocked_still_renders_available_header_shape() -> None:
    rendered = _render([_status("git_status", applicable=False, unmet=("git_repo",))])
    assert "Available, but will fail until fixed:" in rendered
    assert "- `git_status`" in rendered
    assert "No executable tools are available for this request." not in rendered
