"""Security review 2026-10-25 item 1: allowed shell reads must not reach outside the root."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.shell_path_scope import find_out_of_root_argument
from tests.sidecar._platform_skips import make_dir_link


@pytest.fixture
def root(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    (workspace / "src").mkdir(parents=True)
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    return workspace


@pytest.mark.parametrize(
    "command",
    [
        "cat src/app.py",
        "type src\\app.py",
        "ls src/../src",
        "git log --oneline main..HEAD",
        "git log --format=%h%n -5",
        "dir /s /b",
        "grep -rn TODO .",
        "curl https://example.test/../x",
        "findstr /c:needle src\\app.py",
    ],
)
def test_inside_root_arguments_pass(root: Path, command: str) -> None:
    assert find_out_of_root_argument(command, root=str(root), windows=True) is None


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("cat ../secret.txt", "../secret.txt"),
        ("type ..\\..\\secret", "..\\..\\secret"),
        ("type %USERPROFILE%\\.ssh\\id_rsa", "%USERPROFILE%\\.ssh\\id_rsa"),
        ("type %USERPROFILE%", "%USERPROFILE%"),
        ("type \"..\\secret.txt\"", "..\\secret.txt"),
        ("sort < ..\\secret.txt", "..\\secret.txt"),
        ("grep --file=../secret.txt x", "../secret.txt"),
        ("echo ok && type ..\\secret.txt", "..\\secret.txt"),
        ("type \\\\203.0.113.7\\share\\x", "\\\\203.0.113.7\\share\\x"),
        ("type /Windows/win.ini", "/Windows/win.ini"),
    ],
)
def test_outside_root_arguments_are_named(root: Path, command: str, expected: str) -> None:
    assert find_out_of_root_argument(command, root=str(root), windows=True) == expected


def test_an_absolute_path_outside_the_root_is_named(root: Path) -> None:
    secret = str(root.parent / "secret.txt")
    assert find_out_of_root_argument(f'type "{secret}"', root=str(root)) == secret
    inside = str(root / "src" / "app.py")
    assert find_out_of_root_argument(f'type "{inside}"', root=str(root)) is None


def test_cwd_is_the_base_for_relative_arguments(root: Path) -> None:
    assert find_out_of_root_argument("cat ../README.md", root=str(root), cwd="src") is None
    assert find_out_of_root_argument("cat ../../secret.txt", root=str(root), cwd="src") == "../../secret.txt"


@pytest.mark.parametrize(
    ("command", "expected"),
    [("cat $HOME/.ssh/id_rsa", "$HOME/.ssh/id_rsa"), ("cat ~/.ssh/id_rsa", "~/.ssh/id_rsa"),
     ("cat /etc/passwd", "/etc/passwd")],
)
def test_posix_shell_variables_and_home_are_named(root: Path, command: str, expected: str) -> None:
    assert find_out_of_root_argument(command, root=str(root), windows=False) == expected


def test_powershell_variables_are_named_but_pipeline_items_are_not(root: Path) -> None:
    assert find_out_of_root_argument(
        "Get-Content $env:USERPROFILE\\.ssh\\id_rsa", root=str(root), powershell=True, windows=True,
    ) == "$env:USERPROFILE\\.ssh\\id_rsa"
    assert find_out_of_root_argument(
        "Get-ChildItem src | Where-Object { $_.Length -gt 0 }", root=str(root), powershell=True, windows=True,
    ) is None


def test_cmd_leaves_tilde_alone(root: Path) -> None:
    assert find_out_of_root_argument("type ~\\notes.txt", root=str(root), windows=True) is None


def test_a_link_inside_the_root_that_points_outside_is_named(root: Path) -> None:
    outside = root.parent / "outside"
    outside.mkdir()
    make_dir_link(root / "escape", outside)
    (outside / "x").write_text("secret", encoding="utf-8")
    assert find_out_of_root_argument(f"cat escape{os.sep}x", root=str(root)) == f"escape{os.sep}x"
    assert find_out_of_root_argument(f'type "{root / "escape" / "x"}"', root=str(root)) is not None


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("sort 0<C:\\Windows\\win.ini", "C:\\Windows\\win.ini"),
        ("grep x a<C:\\Windows\\win.ini", "C:\\Windows\\win.ini"),
        ("grep x<C:\\Windows\\win.ini", "C:\\Windows\\win.ini"),
        ("type ^C:\\Windows\\win.ini", "C:\\Windows\\win.ini"),
        ("type C^:\\Windows\\win.ini", "C:\\Windows\\win.ini"),
        ("type %SystemRoot:~0,2%\\Windows\\win.ini", "%SystemRoot:~0,2%\\Windows\\win.ini"),
        ("ls -Path:C:\\x", "C:\\x"),
        ("grep -epattern ..\\secret.txt", "..\\secret.txt"),
    ],
)
def test_review_bypasses_are_named(root: Path, command: str, expected: str) -> None:
    assert find_out_of_root_argument(command, root=str(root), windows=True) == expected


@pytest.mark.parametrize("command", ["ls Env:", "dir HKLM:\\SOFTWARE", "Get-Content Cert:\\CurrentUser\\My"])
def test_powershell_provider_drives_are_named(root: Path, command: str) -> None:
    assert find_out_of_root_argument(command, root=str(root), powershell=True, windows=True) is not None


@pytest.mark.parametrize(
    "command",
    [
        'grep -rn "/api/users" src',
        "sed -n '/foo/,/bar/p' src/app.py",
        "awk '/err/ {print}' src/app.py",
        "git log --grep=^fix",
        'findstr /i "/a/b" src\\app.py',
    ],
)
def test_pattern_operands_and_carets_do_not_prompt(root: Path, command: str) -> None:
    assert find_out_of_root_argument(command, root=str(root), windows=True) is None


def test_a_very_long_command_asks_instead_of_resolving_every_word(root: Path) -> None:
    command = "cat " + " ".join(f"src/f{i}.txt" for i in range(600))
    assert find_out_of_root_argument(command, root=str(root)) == "more than 512 arguments"


def test_without_a_bound_root_every_path_argument_is_named() -> None:
    assert find_out_of_root_argument("cat ../x", root=None) == "../x"
    assert find_out_of_root_argument("git status", root=None) is None
