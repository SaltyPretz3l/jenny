"""The keep-working rule for background jobs reaches the prompt only when run_command can start one."""
from __future__ import annotations

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.builder_shared import RuntimeToolStatus

_BACKGROUND_SCHEMA = {
    "type": "object",
    "properties": {"command": {"type": "string"}, "run_in_background": {"type": "boolean"}},
}
_FOREGROUND_SCHEMA = {"type": "object", "properties": {"command": {"type": "string"}}}


def _run_command(*, available: bool = True, schema: dict | None = None) -> RuntimeToolStatus:
    return RuntimeToolStatus(
        name="run_command", display_name="Run Command", available=available,
        input_schema=_BACKGROUND_SCHEMA if schema is None else schema,
    )


@pytest.mark.parametrize("native", [False, True])
def test_background_guidance_reaches_the_assembled_prompt(tmp_path, native):
    prompt = str(ContextBuilder(tmp_path).build_system_prompt(
        "Base prompt", tool_statuses=[_run_command()], native_tool_schemas=native,
        include_skills=False, include_bootstrap=False))
    assert "run_in_background=true and keep working" in prompt
    assert "You are told when a job finishes, so do not poll it or sleep" in prompt
    assert "check_background_job wait_ms only when nothing else can proceed" in prompt


@pytest.mark.parametrize("statuses", [
    [RuntimeToolStatus(name="read_file", display_name="Read", available=True)],
    # A host policy that strips run_in_background (sandboxed POSIX shell) cannot start a job.
    [_run_command(schema=_FOREGROUND_SCHEMA)],
    [_run_command(schema={})],
    [_run_command(available=False), RuntimeToolStatus(name="read_file", display_name="Read", available=True)],
])
def test_background_guidance_stays_out_without_background_capable_run_command(statuses):
    guidance = ContextBuilder._render_tool_loop_guidance(statuses)
    assert "## Tool Use Discipline" in guidance
    assert "run_in_background" not in guidance


@pytest.mark.parametrize("schema", [_BACKGROUND_SCHEMA, _FOREGROUND_SCHEMA])
def test_read_only_inspection_guidance_steers_reads_away_from_scripts(schema):
    # Row 102 follow-up: a read wrapped in a Python script always asks; one run_command need not.
    guidance = ContextBuilder._render_tool_loop_guidance([_run_command(schema=schema)])
    assert "use a typed read tool or one run_command" in guidance
    assert "do not wrap it in a Python or temp script" in guidance


def test_read_only_inspection_guidance_stays_out_without_run_command():
    guidance = ContextBuilder._render_tool_loop_guidance([
        _run_command(available=False),
        RuntimeToolStatus(name="read_file", display_name="Read", available=True),
    ])
    assert "## Tool Use Discipline" in guidance
    assert "temp script" not in guidance
