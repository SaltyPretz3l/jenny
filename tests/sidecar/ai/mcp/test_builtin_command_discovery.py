"""Only selected executable directories enter first-party desktop tool PATH."""
import os
from pathlib import Path

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import builtin_command_discovery as discovery
from sidecar.ai.mcp import process_containment


def executable(root, name):
    root.mkdir(parents=True, exist_ok=True)
    path = root / name
    path.write_text("fixture")
    path.chmod(0o700)
    return path


def test_path_precedes_registration_and_excludes_unrelated_entries(tmp_path, monkeypatch):
    path_python = executable(tmp_path / "chosen python", "python.exe")
    registered = executable(tmp_path / "registered", "python.exe")
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    monkeypatch.setattr(discovery, "registered_pythons", lambda: [registered])
    paths = os.pathsep.join([".", "relative", str(path_python.parent), str(unrelated)])
    result = discovery.discover_command_directories(
        parent_path=paths, windows=True, read_env=lambda _: "", commands=("python",))
    assert result == [str(path_python.parent)]


def test_skips_store_alias_and_missing_paths(tmp_path, monkeypatch):
    alias = executable(tmp_path / "WindowsApps", "python.exe")
    registered = executable(tmp_path / "real Python", "python.exe")
    monkeypatch.setattr(discovery, "registered_pythons", lambda: [tmp_path / "missing", registered])
    assert discovery.discover_command_directories(
        parent_path=str(alias.parent), windows=True, read_env=lambda _: "", commands=("python",)
    ) == [str(registered.parent)]


def test_standard_node_install_covers_node_and_npm(tmp_path):
    for name in ("node.exe", "npm.cmd", "npx.cmd"):
        executable(tmp_path / "nodejs", name)
    result = discovery.discover_command_directories(
        parent_path="", windows=True,
        read_env=lambda key: str(tmp_path) if key == "ProgramFiles" else "",
        commands=("node", "npm", "npx"))
    assert result == [str(tmp_path / "nodejs")]


def test_mixed_command_discovery_preserves_desktop_path_order(tmp_path):
    preferred = tmp_path / "preferred-npm"
    node = tmp_path / "nodejs"
    executable(preferred, "npm.cmd")
    executable(node, "npm.cmd")
    executable(node, "node.exe")
    assert discovery.discover_command_directories(
        parent_path=os.pathsep.join([str(preferred), str(node)]), windows=True,
        read_env=lambda _: "", commands=("node", "npm"),
    ) == [str(preferred), str(node)]


def test_no_matching_tools_is_not_an_error():
    assert discovery.discover_command_directories(
        parent_path="", windows=False, read_env=lambda _: "", commands=("python",)) == []


def test_additional_discovery_is_not_used_for_hosted_or_third_party(monkeypatch):
    def unexpected(**kwargs):
        raise AssertionError("discovery crossed an execution boundary")

    monkeypatch.setattr(process_containment, "discover_command_directories", unexpected)
    for config in (
        MCPServerConfig(name="external", transport="stdio"),
        MCPServerConfig(name="jenny_local_tools", transport="stdio",
                        args=("--host-mode", "server")),
    ):
        assert process_containment._optional_builtin_tool_path_segments(config) == []


def test_relative_and_directory_candidates_are_rejected(tmp_path):
    assert discovery.executable_path(Path("python.exe"), windows=True) is None
    assert discovery.executable_path(tmp_path, windows=True) is None


def test_builtin_private_venv_never_shadows_project_commands(tmp_path, monkeypatch):
    private = executable(tmp_path / "jenny/.venv/Scripts", "python.exe")
    (private.parent.parent / "pyvenv.cfg").write_text("home = fixture")
    project_python = executable(tmp_path / "project-python", "python.exe")
    monkeypatch.setattr(process_containment, "_is_windows", lambda: True)
    monkeypatch.setattr(discovery, "registered_pythons", lambda: [project_python])
    parent_path = os.pathsep.join([str(private.parent), str(project_python.parent)])
    monkeypatch.setattr(process_containment, "read_environment_value", lambda key: parent_path if key == "PATH" else "")
    config = MCPServerConfig(name="jenny_local_tools", transport="stdio", command=str(private))
    path = process_containment._minimal_path(config, private).split(os.pathsep)
    assert str(private.parent) not in path
    assert path[0] == str(project_python.parent)
    assert config.command == str(private), "server interpreter remains explicit"


def test_registered_system_python_is_not_excluded_as_a_private_runtime(tmp_path, monkeypatch):
    python = executable(tmp_path / "system-python", "python.exe")
    monkeypatch.setattr(process_containment, "_is_windows", lambda: True)
    monkeypatch.setattr(discovery, "registered_pythons", lambda: [python])
    monkeypatch.setattr(process_containment, "read_environment_value", lambda _: "")
    config = MCPServerConfig(name="jenny_local_tools", transport="stdio", command=str(python))
    assert str(python.parent) in process_containment._minimal_path(config, python).split(os.pathsep)


def test_hosted_and_external_keep_their_existing_minimal_path(tmp_path, monkeypatch):
    command = tmp_path / "runtime/host.exe"
    monkeypatch.setattr(process_containment, "_default_path_segments", lambda: ("system-bin",))
    for config in (
        MCPServerConfig(name="external", transport="stdio"),
        MCPServerConfig(name="jenny_local_tools", transport="stdio", args=("--host-mode", "server")),
        MCPServerConfig(name="jenny_local_tools", transport="stdio", args=("--host-mode=server",)),
    ):
        assert process_containment._minimal_path(config, command).split(os.pathsep) == [str(command.parent), "system-bin"]


@pytest.mark.parametrize("command", ["rustc", "cargo", "dotnet", "cmake"])
def test_added_tools_prefer_path_and_skip_private_runtime(tmp_path, command):
    private = executable(tmp_path / "private", command + ".exe")
    preferred = executable(tmp_path / "preferred", command + ".exe")
    second = executable(tmp_path / "second", command + ".exe")
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    result = discovery.discover_command_directories(
        parent_path=os.pathsep.join(map(str, [
            unrelated, private.parent, preferred.parent, second.parent,
        ])),
        windows=True, read_env=lambda _: "", commands=(command,),
        excluded_directories=(private.parent,),
    )
    assert result == [str(preferred.parent)]


def test_reduced_path_finds_verified_standard_windows_build_tools(tmp_path, monkeypatch):
    profile, programs, local = [tmp_path / name for name in ("profile", "programs", "local")]
    rust = profile / ".cargo/bin"
    dotnet = programs / "dotnet"
    cmake = programs / "CMake/bin"
    for directory, name in (
        (rust, "rustc.exe"), (rust, "cargo.exe"),
        (dotnet, "dotnet.exe"), (cmake, "cmake.exe"),
    ):
        executable(directory, name)
    monkeypatch.setattr(discovery, "registered_pythons", lambda: [])
    values = {"USERPROFILE": str(profile), "ProgramFiles": str(programs),
              "LOCALAPPDATA": str(local)}
    monkeypatch.setattr(process_containment, "_is_windows", lambda: True)
    monkeypatch.setattr(process_containment, "read_environment_value",
                        lambda key: values.get(key, ""))
    config = MCPServerConfig(name="jenny_local_tools", transport="stdio")
    env = process_containment._minimal_env(config, command_path=None)
    assert env["PATH"].split(os.pathsep) == [str(rust), str(dotnet), str(cmake)]
    assert "ProgramFiles" not in env, "discovery inputs do not become ambient child authority"


def test_dotnet_script_install_and_visual_studio_cmake_candidates(tmp_path):
    local, programs = tmp_path / "local", tmp_path / "programs"
    dotnet = executable(local / "Microsoft/dotnet", "dotnet.exe")
    cmake = executable(
        programs / "Microsoft Visual Studio/2022/BuildTools/Common7/IDE/"
        "CommonExtensions/Microsoft/CMake/CMake/bin", "cmake.exe",
    )
    values = {"LOCALAPPDATA": str(local), "ProgramFiles": str(programs)}
    assert discovery.discover_command_directories(
        parent_path="", windows=True, read_env=lambda key: values.get(key, ""),
        commands=("dotnet", "cmake"),
    ) == [str(dotnet.parent), str(cmake.parent)]


def test_missing_standard_build_tools_leave_path_empty(tmp_path):
    assert discovery.discover_command_directories(
        parent_path=str(tmp_path), windows=True, read_env=lambda _: str(tmp_path),
        commands=("rustc", "cargo", "dotnet", "cmake"),
    ) == []


def test_standard_installation_discovery_is_bounded(tmp_path):
    for number in range(discovery.MAX_STANDARD_INSTALLATIONS + 1):
        executable(
            tmp_path / f"Microsoft Visual Studio/2022/edition-{number}/Common7/IDE/"
            "CommonExtensions/Microsoft/CMake/CMake/bin", "cmake.exe",
        )
    assert len(discovery.windows_candidates(
        "cmake", lambda key: str(tmp_path) if key == "ProgramFiles" else "",
    )) == discovery.MAX_STANDARD_INSTALLATIONS + 1  # One fixed installer candidate.
