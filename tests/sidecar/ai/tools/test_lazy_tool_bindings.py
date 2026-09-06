"""Every lazily-bound tool handler must actually resolve.

`registry._lazy_tool_handler` addresses its target by STRING module and handler
name, and those handler modules are listed in `DEFERRED_MODULE_STATUS` in
`scripts/checks/check_sidecar_reachability.py` so the reachability gate no longer
walks them. Without this test a typo in either half of a pair would not fail any
build -- it would fail the user, the first time they used that tool.
"""

from __future__ import annotations

from sidecar.ai.tools import registry


def _lazy_bindings() -> list[tuple[str, object]]:
    found = []
    for name in dir(registry):
        candidate = getattr(registry, name)
        if callable(candidate) and hasattr(candidate, "lazy_target"):
            found.append((name, candidate))
    return found


def test_every_lazy_tool_binding_resolves_to_a_callable() -> None:
    bindings = _lazy_bindings()
    assert bindings, "expected registry to define lazily-bound tool handlers"

    failures = []
    for name, handler in bindings:
        module_name, handler_name = handler.lazy_target
        try:
            resolved = handler.resolve()
        except Exception as error:  # noqa: BLE001 - report every broken pair at once
            failures.append(f"{name}: {module_name}.{handler_name} raised {error!r}")
            continue
        if not callable(resolved):
            failures.append(f"{name}: {module_name}.{handler_name} is not callable")

    assert not failures, "unresolvable lazy tool bindings:\n" + "\n".join(failures)
