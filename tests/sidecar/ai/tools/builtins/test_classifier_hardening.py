"""Classifier hardening from the 2026-10-19 tool review.

Three gaps let a command run or ask the wrong question:

* a safe executable's ALLOWED verdict carried command substitution
  (``echo $(rm -rf x)``) and writer/launcher arguments (``sort -o``,
  ``sed e``, ``tar -x``) past approval;
* the always-on destructive detector looked only at ``argv[0]``, so
  ``sudo rm``, ``(rm x)`` and ``then rm x`` were not asked about;
* the blocked literals matched anywhere in the raw string, so
  ``git log --format %H`` and a commit message containing "reboot" were
  refused outright.
"""

from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins.shell_security import (
    CommandVerdict,
    classify_command,
    find_blocked_pattern,
    find_destructive_executable,
)


@pytest.mark.parametrize(
    "command",
    [
        "echo $(rm -rf ./data)",
        "echo `rm x`",
        "cat <(rm x)",
        "ls > >(tee out)",
    ],
)
def test_command_substitution_needs_approval(command: str) -> None:
    result = classify_command(command)
    assert result.verdict is CommandVerdict.NEEDS_APPROVAL
    assert result.reason == "command substitution"


def test_powershell_backtick_is_an_escape_not_a_substitution() -> None:
    result = classify_command("Get-ChildItem `-Recurse", powershell=True)
    assert result.reason != "command substitution"
    assert classify_command("echo $(rm x)", powershell=True).reason == "command substitution"


@pytest.mark.parametrize(
    ("command", "reason_prefix"),
    [
        ('awk "BEGIN{system(\\"calc\\")}"', "awk program"),
        ("awk '{getline x}' f", "awk program"),
        ('sed -n "1e calc" f', "sed command"),
        ("sed 's/a/b/w out' f", "sed command"),
        ("sed -f script.sed f", "sed script file"),
        ("sort -o a.txt b.txt", "sort argument"),
        ("sort --output=a.txt b.txt", "sort argument"),
        ("rg --pre calc foo", "rg argument"),
        ("find . -fprint x", "find argument"),
        ("find . -fls listing", "find argument"),
    ],
)
def test_safe_executable_arguments_that_write_or_launch_need_approval(
    command: str,
    reason_prefix: str,
) -> None:
    result = classify_command(command)
    assert result.verdict is CommandVerdict.NEEDS_APPROVAL, result
    assert result.reason.startswith(reason_prefix), result.reason


@pytest.mark.parametrize(
    "command",
    [
        "awk '{print $1}' f",
        "sed -n '1,5p' f",
        "sed 's/a/b/' f",
        "sed -e 's/we/x/' f",
        "sort b.txt",
        "rg foo",
        "find . -name '*.py'",
    ],
)
def test_read_only_text_tool_uses_stay_allowed(command: str) -> None:
    assert classify_command(command).verdict is CommandVerdict.ALLOWED


@pytest.mark.parametrize("command", ["tar -xf a.tar", "zip -r a.zip .", "unzip a.zip", "gzip a.txt", "gunzip a.gz", "yq -i . f.yaml"])
def test_archive_and_yq_tools_are_no_longer_auto_allowed(command: str) -> None:
    assert classify_command(command).verdict is CommandVerdict.NEEDS_APPROVAL


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("sudo rm -rf x", "rm"),
        ("sudo -u root rm -rf x", "rm"),
        ("env rm -rf x", "rm"),
        ("env FOO=1 bash -c 'rm -rf x'", "rm"),
        ("nohup rm -rf x", "rm"),
        ("time rm x", "rm"),
        ("command rm x", "rm"),
        ("timeout 5 rm x", "rm"),
        ("busybox rm x", "rm"),
        ("(rm -rf x)", "rm"),
        ("{ rm -rf x; }", "rm"),
        ("if true; then rm x; fi", "rm"),
        ("echo hi && (del x)", "del"),
    ],
)
def test_destructive_detector_sees_through_wrappers_and_grouping(
    command: str,
    expected: str,
) -> None:
    assert find_destructive_executable(command) == expected


@pytest.mark.parametrize("command", ["echo ok", "ls (a)", "sudo ls", "timeout 5 sleep 1"])
def test_wrappers_around_harmless_commands_are_not_destructive(command: str) -> None:
    assert find_destructive_executable(command) is None


@pytest.mark.parametrize(
    "command",
    [
        "ruff format src",
        "git log --format %H",
        'git commit -m "fix reboot loop"',
        "rm -rf /tmp/x",
        "echo shutdown later",
    ],
)
def test_ordinary_work_is_not_blocked(command: str) -> None:
    assert find_blocked_pattern(command) is None
    assert classify_command(command).verdict is not CommandVerdict.BLOCKED


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf /",
        "rm -rf /*",
        "rm -fr /",
        "ls; rm -rf /",
        "format C:",
        "format\tC:",
        "sudo reboot",
        "reboot",
        "ls && reboot",
        "shutdown -h now",
        "mkfs.ext4 /dev/sda1",
        "del /f /s /q C:\\",
    ],
)
def test_system_commands_at_command_position_stay_blocked(command: str) -> None:
    assert classify_command(command).verdict is CommandVerdict.BLOCKED
