from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.container import (
    _apply_context_length_override,
    _default_mcp_servers,
    _sub_agent_slot_allocator_for_config,
)


def test_default_mcp_servers_forward_web_configuration(tmp_path: Path) -> None:
    config = RuntimeConfig(
        tools_web_enabled=True,
        tools_mermaid_enabled=True,
        tools_workspace_manifest_enabled=True,
        tools_rich_files_enabled=True,
        tools_web_rate_limit_per_min=17,
        tools_web_max_fetch_bytes=8192,
        tools_web_allow_private_addresses=True,
        tools_web_search_provider="bing",
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    assert len(servers) == 1
    args = list(servers[0].args)
    assert "--web-enabled" in args
    assert args[args.index("--web-enabled") + 1] == "1"
    assert args[args.index("--web-rate-limit-per-min") + 1] == "17"
    assert args[args.index("--web-max-fetch-bytes") + 1] == "8192"
    assert args[args.index("--web-allow-private-addresses") + 1] == "1"
    assert args[args.index("--web-search-provider") + 1] == "bing"
    assert "--mermaid-enabled" in args
    assert args[args.index("--mermaid-enabled") + 1] == "1"
    assert "--workspace-manifest-enabled" in args
    assert args[args.index("--workspace-manifest-enabled") + 1] == "1"
    assert "--rich-files-enabled" in args
    assert args[args.index("--rich-files-enabled") + 1] == "1"


def test_default_mcp_servers_forward_connections(tmp_path: Path) -> None:
    from sidecar.ai.config import MCPServerConfig

    config = RuntimeConfig(
        engine_type="openai-compatible",
        api_url="https://user:secret@api.example.com/v1?token=hidden",
        mcp_servers=(
            MCPServerConfig(
                name="research",
                transport="sse",
                url="https://mcp-user:mcp-secret@mcp.example.com/rpc?token=hidden",
            ),
        ),
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001
    args = list(servers[0].args)

    assert args[args.index("--connections-enabled") + 1] == "1"
    assert args[args.index("--connections-engine-type") + 1] == "openai-compatible"
    assert args[args.index("--connections-engine-host") + 1] == "api.example.com"
    server_index = args.index("--connections-mcp-server")
    assert args[server_index + 1 : server_index + 4] == ["research", "sse", "mcp.example.com"]
    assert "secret" not in " ".join(args)


def test_context_length_override_does_not_follow_a_fallback_model() -> None:
    config = RuntimeConfig(
        engine_type="ollama",
        model="ornith:9b",
        context_length=32_768,
        context_length_override=131_072,
    )

    unchanged = _apply_context_length_override(
        config,
        selected_engine_type="ollama",
        selected_model="fallback:9b",
    )

    assert unchanged.context_length == 32_768


@pytest.mark.parametrize(
    ("engine_type", "local_setting", "expected_global", "expected_per_parent"),
    [("chatgpt", 1, 2, 2), ("mock", 3, 3, 1)],
)
def test_sub_agent_allocator_uses_active_engine_profile(
    engine_type: str,
    local_setting: int,
    expected_global: int,
    expected_per_parent: int,
) -> None:
    allocator = _sub_agent_slot_allocator_for_config(
        RuntimeConfig(
            engine_type=engine_type,
            max_sub_agent_concurrency=local_setting,
            max_cloud_sub_agent_concurrency=2,
        )
    )

    snapshot = allocator.snapshot()
    assert snapshot["max_active_sub_agents"] == expected_global
    assert snapshot["max_sub_agents_per_parent"] == expected_per_parent


def test_default_mcp_servers_forward_pre_change_snapshot_root(tmp_path: Path) -> None:
    state_root = tmp_path / "electron-state"
    configured = _default_mcp_servers(
        RuntimeConfig(electron_state_root=str(state_root)),
        tmp_path,
    )
    unconfigured = _default_mcp_servers(RuntimeConfig(), tmp_path)

    configured_args = list(configured[0].args)
    unconfigured_args = list(unconfigured[0].args)
    flag = "--pre-change-snapshot-root"
    assert configured_args[configured_args.index(flag) + 1] == str(
        state_root / "workspace-snapshots"
    )
    assert unconfigured_args[unconfigured_args.index(flag) + 1] == ""


def test_default_mcp_servers_forward_lsp_configuration(tmp_path: Path) -> None:
    config = RuntimeConfig(
        tools_lsp_enabled=True,
        tools_lsp_command_typescript="typescript-language-server",
        tools_lsp_command_python="pyright-langserver",
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    assert len(servers) == 1
    args = list(servers[0].args)
    assert "--lsp-enabled" in args
    assert args[args.index("--lsp-enabled") + 1] == "1"
    assert args[args.index("--lsp-command-typescript") + 1] == "typescript-language-server"
    assert args[args.index("--lsp-command-python") + 1] == "pyright-langserver"


def test_default_mcp_servers_forward_knowledge_configuration(tmp_path: Path) -> None:
    config = RuntimeConfig(
        tools_knowledge_enabled=True,
        knowledge_roots=("C:\\docs\\project-x", "D:\\handbook"),
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    assert len(servers) == 1
    args = list(servers[0].args)
    assert "--knowledge-enabled" in args
    assert args[args.index("--knowledge-enabled") + 1] == "1"
    root_values = [args[i + 1] for i, token in enumerate(args) if token == "--knowledge-root"]
    assert root_values == ["C:\\docs\\project-x", "D:\\handbook"]


def test_default_mcp_servers_omit_knowledge_roots_when_disabled(tmp_path: Path) -> None:
    config = RuntimeConfig(
        tools_knowledge_enabled=False,
        knowledge_roots=("C:\\docs\\project-x",),
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    args = list(servers[0].args)
    assert args[args.index("--knowledge-enabled") + 1] == "0"
    # Flag-off must not advertise the user's folder paths in argv.
    assert "--knowledge-root" not in args


def test_default_mcp_servers_forward_shell_security_and_git_tracking_flags(
    tmp_path: Path,
) -> None:
    # SECURITY: run_command executes inside the builtin-tools subprocess, so the
    # shell-security classifier and git-tracking telemetry are inert unless these
    # feature flags are forwarded across the process boundary.
    config = RuntimeConfig(
        tools_shell_enabled=True,
        feature_flags={"shell_security": True, "git_tracking": True},
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    args = list(servers[0].args)
    assert args[args.index("--shell-security-enabled") + 1] == "1"
    assert args[args.index("--git-tracking-enabled") + 1] == "1"


def test_default_mcp_servers_shell_security_and_git_tracking_default_off(
    tmp_path: Path,
) -> None:
    config = RuntimeConfig()

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    args = list(servers[0].args)
    assert args[args.index("--shell-security-enabled") + 1] == "0"
    assert args[args.index("--git-tracking-enabled") + 1] == "0"


def test_default_mcp_servers_forward_skill_scope_roots(tmp_path: Path) -> None:
    # load_skill is the only tool that can reach the bundled/user/project skill
    # scope roots the context builder advertises -- WorkspaceGuard confines
    # every other tool to the tools workspace root. Without this forwarding
    # the builtin-tools subprocess never learns where those roots are, and
    # load_skill silently reports every indexed skill as unknown.
    config = RuntimeConfig(
        tools_load_skill_enabled=True,
        skills_bundled_root="C:\\jenny\\skills",
        skills_bundled_enabled=True,
        skills_user_root="C:\\Users\\me\\.jenny\\skills",
        skills_user_enabled=False,
        skills_project_root="D:\\proj\\.jenny\\skills",
        skills_project_enabled=True,
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    assert len(servers) == 1
    args = list(servers[0].args)
    assert args[args.index("--load-skill-enabled") + 1] == "1"
    assert args[args.index("--skill-bundled-root") + 1] == "C:\\jenny\\skills"
    assert args[args.index("--skill-bundled-enabled") + 1] == "1"
    assert args[args.index("--skill-user-root") + 1] == "C:\\Users\\me\\.jenny\\skills"
    assert args[args.index("--skill-user-enabled") + 1] == "0"
    assert args[args.index("--skill-project-root") + 1] == "D:\\proj\\.jenny\\skills"
    assert args[args.index("--skill-project-enabled") + 1] == "1"


def test_default_mcp_servers_skill_scope_roots_default_off_and_empty(tmp_path: Path) -> None:
    config = RuntimeConfig()

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    args = list(servers[0].args)
    assert args[args.index("--load-skill-enabled") + 1] == "1"
    assert args[args.index("--skill-bundled-root") + 1] == ""
    assert args[args.index("--skill-user-root") + 1] == ""
    assert args[args.index("--skill-project-root") + 1] == ""


def test_default_mcp_servers_forward_sibling_tool_flags(tmp_path: Path) -> None:
    # Same defect class: config that the subprocess reconstructs from argv must be
    # forwarded, or a non-default value silently diverges from the user's setting.
    config = RuntimeConfig(
        tools_delete_file_enabled=False,
        tools_move_file_enabled=False,
        tools_image_read_enabled=True,
        tools_todo_enabled=True,
        tools_web_searxng_url="http://searx.local:8080",
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    args = list(servers[0].args)
    assert args[args.index("--delete-file-enabled") + 1] == "0"
    assert args[args.index("--move-file-enabled") + 1] == "0"
    assert args[args.index("--image-read-enabled") + 1] == "1"
    assert args[args.index("--todo-enabled") + 1] == "1"
    assert args[args.index("--web-searxng-url") + 1] == "http://searx.local:8080"


def test_default_mcp_servers_strip_searxng_url_credentials_before_argv(
    tmp_path: Path,
) -> None:
    # SECURITY: argv is world-readable, so embedded basic-auth credentials on a
    # self-hosted searxng URL must never reach the subprocess command line.
    config = RuntimeConfig(
        tools_web_searxng_url="https://scout:hunter2@searxng.example.com/search?q=x",
    )

    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001

    forwarded = list(servers[0].args)[
        list(servers[0].args).index("--web-searxng-url") + 1
    ]
    assert "hunter2" not in forwarded
    assert "scout" not in forwarded
    assert "@" not in forwarded
    assert forwarded == "https://searxng.example.com/search?q=x"


def test_default_mcp_servers_use_packaged_builtin_server_entrypoint(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import sidecar.ai.container as container_mod
    import sidecar.ai.container_mcp_servers as mcp_servers_mod

    monkeypatch.setattr(mcp_servers_mod.sys, "frozen", True, raising=False)
    monkeypatch.setattr(mcp_servers_mod.sys, "executable", "C:/Jenny/sidecar.exe")

    servers = container_mod._default_mcp_servers(RuntimeConfig(), tmp_path)  # noqa: SLF001

    assert len(servers) == 1
    assert servers[0].command == "C:/Jenny/sidecar.exe"
    args = list(servers[0].args)
    assert args[0] == "--mcp-builtin-server"
    assert "-m" not in args[:2]
    assert "--workspace-root" in args
    assert args[args.index("--workspace-root") + 1] == str(tmp_path)


def test_brain_container_passes_turn_diagnostics_to_harness_builder(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import sidecar.ai.container as container_mod

    harness_kwargs: dict[str, object] = {}
    router = MagicMock()
    memory_store = MagicMock()
    engine = SimpleNamespace(
        unload_model=lambda: None,
        close=lambda: None,
        set_turn_diagnostics_store=lambda store: None,
    )

    observed_progress_callback: list[object] = []

    def create_engine_with_progress(_cfg, *, progress_callback=None, **_kwargs):
        observed_progress_callback.append(progress_callback)
        return SimpleNamespace(
            engine=engine,
            engine_type="mock",
            model="mock-v1",
            fallback_from=None,
            fallback_reason=None,
        )

    monkeypatch.setattr(container_mod, "create_engine", create_engine_with_progress)
    monkeypatch.setattr(
        container_mod, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db"
    )
    # Keep MonitorManager off the live runtime root: its constructor prunes (i.e.
    # DELETES) terminal status records over the cap, and configure() then calls
    # recover_stale_monitors(), which rewrites any running+persistent monitor to
    # state="stale". Unstubbed, these unit tests reap the user's real background
    # monitors under ~/.companion/background-memory.
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    monkeypatch.setattr(container_mod, "MemoryStore", lambda _path: memory_store)
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "MCPClient", lambda **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kwargs: router)

    def _build_harness(**kwargs):
        harness_kwargs.update(kwargs)
        return MagicMock(inspect=MagicMock())

    monkeypatch.setattr(container_mod, "HarnessSnapshotBuilder", _build_harness)

    from sidecar.ai.container import BrainContainer

    container = BrainContainer()

    def progress_callback(_payload) -> None:
        pass
    stack = container.configure({}, progress_callback=progress_callback)

    assert harness_kwargs["turn_diagnostics"] is stack.turn_diagnostics
    assert observed_progress_callback == [progress_callback]


@pytest.mark.parametrize(
    ("context_length_override", "expected_context_length"),
    [(None, 131_072), (65_536, 65_536)],
)
def test_brain_container_applies_final_context_length_to_ollama_engine(
    monkeypatch,
    tmp_path: Path,
    context_length_override: int | None,
    expected_context_length: int,
) -> None:
    import sidecar.ai.container as container_mod

    captured_configs: list[RuntimeConfig] = []
    engine = MagicMock()
    engine.unload_model = MagicMock()
    engine.close = MagicMock()
    engine.set_turn_diagnostics_store = MagicMock()
    engine.set_configured_context_length = MagicMock()

    def _create_engine(config: RuntimeConfig, **_kwargs):
        captured_configs.append(config)
        return SimpleNamespace(
            engine=engine,
            engine_type="ollama",
            model="qwen3.6:35b-a3b-ud-q4_k_xl",
            fallback_from=None,
            fallback_reason=None,
        )

    monkeypatch.setattr(container_mod, "create_engine", _create_engine)
    monkeypatch.setattr(
        container_mod, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db"
    )
    # Keep MonitorManager off the live runtime root: its constructor prunes (i.e.
    # DELETES) terminal status records over the cap, and configure() then calls
    # recover_stale_monitors(), which rewrites any running+persistent monitor to
    # state="stale". Unstubbed, these unit tests reap the user's real background
    # monitors under ~/.companion/background-memory.
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    monkeypatch.setattr(container_mod, "MemoryStore", lambda _path: MagicMock())
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "MCPClient", lambda **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kwargs: MagicMock())
    monkeypatch.setattr(
        container_mod,
        "HarnessSnapshotBuilder",
        lambda **kwargs: MagicMock(inspect=MagicMock()),
    )

    from sidecar.ai.container import BrainContainer

    container = BrainContainer()

    raw_config = {
        "engine_type": "ollama",
        "model": "qwen3.6:35b-a3b-ud-q4_k_xl",
        "context_length": 4096,
    }
    if context_length_override is not None:
        raw_config["context_length_override"] = context_length_override
    stack = container.configure(raw_config)

    assert captured_configs[0].context_length == 4096
    assert stack.config.context_length == expected_context_length
    engine.set_configured_context_length.assert_called_once_with(expected_context_length)


def test_brain_container_closes_remaining_resources_when_a_resource_close_fails(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import sidecar.ai.container as container_mod

    mcp_clients: list[MagicMock] = []
    memory_stores: list[MagicMock] = []
    engines: list[MagicMock] = []

    def _create_engine(_cfg, **_kwargs):
        engine = MagicMock()
        engine.unload_model = MagicMock()
        engine.set_turn_diagnostics_store = MagicMock()
        engines.append(engine)
        return SimpleNamespace(
            engine=engine,
            engine_type="mock",
            model="mock-v1",
            fallback_from=None,
            fallback_reason=None,
        )

    def _mcp_client(**_kwargs):
        client = MagicMock()
        client.close = MagicMock()
        mcp_clients.append(client)
        return client

    def _memory_store(_path):
        store = MagicMock()
        store.close = MagicMock()
        memory_stores.append(store)
        return store

    monkeypatch.setattr(container_mod, "create_engine", _create_engine)
    monkeypatch.setattr(
        container_mod, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db"
    )
    # Keep MonitorManager off the live runtime root: its constructor prunes (i.e.
    # DELETES) terminal status records over the cap, and configure() then calls
    # recover_stale_monitors(), which rewrites any running+persistent monitor to
    # state="stale". Unstubbed, these unit tests reap the user's real background
    # monitors under ~/.companion/background-memory.
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    monkeypatch.setattr(container_mod, "MemoryStore", _memory_store)
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "MCPClient", _mcp_client)
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kwargs: MagicMock())
    monkeypatch.setattr(
        container_mod,
        "HarnessSnapshotBuilder",
        lambda **kwargs: MagicMock(inspect=MagicMock()),
    )

    from sidecar.ai.container import BrainContainer

    container = BrainContainer()

    first_stack = container.configure({})
    first_mcp = mcp_clients[0]
    first_mcp.close.side_effect = RuntimeError("close failed")
    first_memory = memory_stores[0]
    first_engine = engines[0]

    with container.stack_lease() as leased_stack:
        second_stack = container.configure({})
        assert leased_stack is first_stack
        assert container.stack is first_stack
        first_mcp.close.assert_not_called()
        first_memory.close.assert_not_called()
        first_engine.unload_model.assert_not_called()

    first_mcp.close.assert_called_once()
    first_memory.close.assert_called_once()
    first_engine.unload_model.assert_called_once()
    assert container.stack is second_stack


def test_failed_reconfigure_closes_candidate_resources_and_preserves_old_stack(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import sidecar.ai.container as container_mod

    engines: list[MagicMock] = []
    memories: list[MagicMock] = []
    monitors: list[MagicMock] = []
    clients: list[MagicMock] = []

    def _create_engine(_config, **_kwargs):
        engine = MagicMock()
        engines.append(engine)
        return SimpleNamespace(
            engine=engine,
            engine_type="mock",
            model="mock-v1",
            fallback_from=None,
            fallback_reason=None,
        )

    def _memory_store(_path):
        store = MagicMock()
        memories.append(store)
        return store

    def _monitor_manager(**_kwargs):
        manager = MagicMock()
        monitors.append(manager)
        return manager

    def _mcp_client(**_kwargs):
        client = MagicMock()
        clients.append(client)
        return client

    def _harness_builder(**_kwargs):
        if len(engines) == 2:
            raise RuntimeError("injected harness construction failure")
        return MagicMock(inspect=MagicMock())

    monkeypatch.setattr(container_mod, "create_engine", _create_engine)
    monkeypatch.setattr(
        container_mod, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db"
    )
    # Keep MonitorManager off the live runtime root: its constructor prunes (i.e.
    # DELETES) terminal status records over the cap, and configure() then calls
    # recover_stale_monitors(), which rewrites any running+persistent monitor to
    # state="stale". Unstubbed, these unit tests reap the user's real background
    # monitors under ~/.companion/background-memory.
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    monkeypatch.setattr(container_mod, "MemoryStore", _memory_store)
    monkeypatch.setattr(container_mod, "MonitorManager", _monitor_manager)
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "MCPClient", _mcp_client)
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "HarnessSnapshotBuilder", _harness_builder)

    from sidecar.ai.container import BrainContainer

    container = BrainContainer()
    old_stack = container.configure({})

    try:
        container.configure({})
    except RuntimeError as error:
        assert "injected harness" in str(error)
    else:  # pragma: no cover - assertion clarity
        raise AssertionError("reconfigure should fail")

    assert container.stack is old_stack
    engines[0].close.assert_not_called()
    memories[0].close.assert_not_called()
    monitors[0].close.assert_not_called()
    clients[0].close.assert_not_called()
    engines[1].unload_model.assert_called_once()
    engines[1].close.assert_called_once()
    memories[1].close.assert_called_once()
    monitors[1].close.assert_called_once()
    clients[1].close.assert_called_once()


def test_default_mcp_servers_forward_distill_configuration(tmp_path: Path) -> None:
    # Regression: tools_distill_enabled was never threaded to the builtin-tools
    # subprocess, so the reconstructed config dict there omitted the key and
    # tool-output distillation silently disabled in live chat.
    enabled = _default_mcp_servers(RuntimeConfig(tools_distill_enabled=True), tmp_path)
    disabled = _default_mcp_servers(RuntimeConfig(tools_distill_enabled=False), tmp_path)

    enabled_args = list(enabled[0].args)
    disabled_args = list(disabled[0].args)
    assert enabled_args[enabled_args.index("--distill-enabled") + 1] == "1"
    assert disabled_args[disabled_args.index("--distill-enabled") + 1] == "0"


def _install_light_container_stubs(monkeypatch, container_mod, tmp_path: Path) -> None:
    engine = SimpleNamespace(
        unload_model=lambda: None,
        close=lambda: None,
        set_turn_diagnostics_store=lambda store: None,
    )
    monkeypatch.setattr(
        container_mod,
        "create_engine",
        lambda _cfg, **_kwargs: SimpleNamespace(
            engine=engine,
            engine_type="mock",
            model="mock-v1",
            fallback_from=None,
            fallback_reason=None,
        ),
    )
    monkeypatch.setattr(
        container_mod, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db"
    )
    # Keep MonitorManager off the live runtime root: its constructor prunes (i.e.
    # DELETES) terminal status records over the cap, and configure() then calls
    # recover_stale_monitors(), which rewrites any running+persistent monitor to
    # state="stale". Unstubbed, these unit tests reap the user's real background
    # monitors under ~/.companion/background-memory.
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    monkeypatch.setattr(container_mod, "MemoryStore", lambda _path: MagicMock())
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "MCPClient", lambda **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kwargs: MagicMock())
    monkeypatch.setattr(
        container_mod,
        "HarnessSnapshotBuilder",
        lambda **kwargs: MagicMock(inspect=MagicMock()),
    )


def test_brain_container_configure_enables_reliability_net_in_main_process(
    monkeypatch,
    tmp_path: Path,
) -> None:
    # The reliability net's is_healing_enabled() gate is read in the MAIN router
    # process (in-band tool-call parsing, reflexive retry, and the per-turn
    # ai.router.tool_call_reliability emit). Its only configurator call lived in
    # build_tool_bindings, which in live chat runs solely in the builtin-tools
    # subprocess -- so the main process never enabled the net. Wiring the config
    # at BrainContainer.configure is what makes the net + telemetry actually
    # engage. Regression pin: configure must reflect the flag in the main process.
    import sidecar.ai.container as container_mod
    from sidecar.ai.tools import tool_call_healing

    _install_light_container_stubs(monkeypatch, container_mod, tmp_path)
    from sidecar.ai.container import BrainContainer

    def _configure(raw_config: dict[str, object]) -> None:
        container = BrainContainer()
        container.configure(raw_config)

    tool_call_healing.configure_tool_call_healing(None)
    assert tool_call_healing.is_healing_enabled() is False

    _configure({"tool_call_reliability_net_enabled": True})
    assert tool_call_healing.is_healing_enabled() is True

    _configure({"tool_call_reliability_net_enabled": False})
    assert tool_call_healing.is_healing_enabled() is False


def test_configure_keeps_secrets_out_of_raw_config_and_clears_them_when_absent(
    monkeypatch,
    tmp_path: Path,
) -> None:
    # H1: raw_config is copied wholesale into plaintext background-worker payload
    # files, so a bearer token must live in stack.secrets instead. RuntimeConfig
    # still carries it -- that copy is read in-process and never serialized.
    import json

    import sidecar.ai.container as container_mod

    _install_light_container_stubs(monkeypatch, container_mod, tmp_path)
    from sidecar.ai.container import BrainContainer

    sentinel = "sentinel-bearer-token-value"
    container = BrainContainer()

    inlined = container.configure({"engine_type": "chatgpt", "chatgpt_access_token": sentinel})
    assert "chatgpt_access_token" not in inlined.raw_config
    assert inlined.secrets == {"chatgpt_access_token": sentinel}
    assert inlined.config.chatgpt_access_token == sentinel
    assert sentinel not in json.dumps(inlined.raw_config)

    brokered = container.configure({"engine_type": "chatgpt"}, secrets={"chatgpt_access_token": sentinel})
    assert "chatgpt_access_token" not in brokered.raw_config
    assert brokered.secrets == {"chatgpt_access_token": sentinel}
    assert brokered.config.chatgpt_access_token == sentinel
    assert sentinel not in json.dumps(brokered.raw_config)

    # ABSENT MEANS CLEAR: sign-out omits the key entirely.
    cleared = container.configure({})
    assert cleared.secrets == {}
    assert cleared.config.chatgpt_access_token is None


# ---------------------------------------------------------------------------
# Provider capability profiles reach the store the diagnostics payload reads.
#
# `create_engine` ran BEFORE `ProviderCapabilityProfileStore()` was constructed
# and attached -- and `create_engine` executes `load_model`, the SOLE writer of
# profiles. Every profile a load recorded was therefore discarded, and
# `provider_capability_profiles_payload` (exposed via the `initialize` response
# and `harness.inspect`) always returned [].
# ---------------------------------------------------------------------------


def test_container_records_capability_profiles_written_during_engine_load(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import sidecar.ai.container as container_mod
    from sidecar.ai.engines.factory import create_engine as real_create_engine
    from sidecar.runtime.provider_capability_profile import (
        provider_capability_profiles_payload,
    )

    _install_light_container_stubs(monkeypatch, container_mod, tmp_path)
    # Put the REAL factory back. The defect is the ORDER in which container.py
    # builds the store relative to create_engine, so a stubbed factory (which
    # never calls load_model) cannot observe it.
    monkeypatch.setattr(container_mod, "create_engine", real_create_engine)

    stack = container_mod.BrainContainer().configure(
        {"engine_type": "mock", "model": "mock-v1"}
    )

    profiles = stack.provider_capability_profiles.all_profiles()
    assert profiles, (
        "the capability probe recorded during load_model must land in the store "
        "the initialize/harness.inspect payload reads"
    )
    assert provider_capability_profiles_payload(stack.provider_capability_profiles), (
        "the diagnostics payload must stop reporting an empty list"
    )


def test_create_engine_attaches_the_profile_store_before_loading_the_model() -> None:
    """Factory-level pin: attachment must precede load_model, not follow it."""
    from sidecar.ai.config import RuntimeConfig as _RuntimeConfig
    from sidecar.ai.engines.factory import create_engine
    from sidecar.runtime.provider_capability_profile import (
        ProviderCapabilityProfileStore,
    )

    store = ProviderCapabilityProfileStore()
    selection = create_engine(
        _RuntimeConfig(engine_type="mock", model="mock-v1"),
        capability_profile_store=store,
    )

    assert selection.engine_type == "mock"
    assert store.all_profiles(), "load_model's probe result must be recorded"


def test_create_engine_without_a_store_still_loads() -> None:
    """The parameter is optional: omitting it keeps the previous behaviour."""
    from sidecar.ai.config import RuntimeConfig as _RuntimeConfig
    from sidecar.ai.engines.factory import create_engine

    selection = create_engine(_RuntimeConfig(engine_type="mock", model="mock-v1"))

    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
