"""The decision sources ``policy.evaluate_tool_policy`` consults, in precedence order.

User rules (matched on descriptor metadata and the raw call arguments: path
prefix, action, command prefix/exact), then a stored legacy per-tool policy, then
the built-in per-tool defaults. services/tools/tool-policy-evaluator.js mirrors
these semantics and the defaults table for the Electron-side evaluator.
"""

from __future__ import annotations

import ntpath
import posixpath
import re
from typing import Any

from sidecar.ai.config_models import ToolPolicyRule, ToolPolicySnapshot
from sidecar.ai.tools.command_prefix import command_matches_exact, command_matches_prefix

POLICY_DECISION_AUTO = "auto"
POLICY_DECISION_ASK = "ask"
POLICY_DECISION_DENY = "deny"
_VALID_POLICY_DECISIONS = frozenset(
    {POLICY_DECISION_AUTO, POLICY_DECISION_ASK, POLICY_DECISION_DENY}
)
_LEGACY_POLICY_DECISION_PRIORITY = {
    POLICY_DECISION_AUTO: 1,
    POLICY_DECISION_ASK: 2,
    POLICY_DECISION_DENY: 3,
}
_DELEGATE_COMPATIBILITY_TOOL_IDS = (
    "delegate",
    "subagent_run",
    "subagent_batch",
)
_RULE_HIT_STAGE = {
    POLICY_DECISION_DENY: "user_deny",
    POLICY_DECISION_AUTO: "user_allow",
    POLICY_DECISION_ASK: "user_ask",
}
_DEFAULT_TOOL_DEFAULTS = {
    # The Electron tool owns exact-content consent, independently of run mode.
    "session_message": "auto",
    # Consent is asked inside the tool (Electron), so per-call policy stays out of the way.
    "browser": "auto",
    "read_file": POLICY_DECISION_AUTO,
    "glob_files": POLICY_DECISION_AUTO,
    "grep_search": POLICY_DECISION_AUTO,
    "write_file": POLICY_DECISION_ASK,
    "edit_file": POLICY_DECISION_ASK,
    # Plan Plus: records a suggestion for review and writes nothing, so it never
    # prompts; applying a suggestion is its own consented path.
    "propose_change": POLICY_DECISION_AUTO,
    # Home writes touch only Jenny's own Home surfaces, are attributed and
    # one-click undoable, and deletes self-gate behind a confirm round-trip;
    # without this entry the non-read-only descriptor falls through to ask.
    "home": POLICY_DECISION_AUTO,
    "run_command": POLICY_DECISION_ASK,
    "run_temp_script": POLICY_DECISION_ASK,
    "monitor": POLICY_DECISION_ASK,
    "check_monitor": POLICY_DECISION_AUTO,
    "recall_tool_output": POLICY_DECISION_AUTO,
    "create_artifact": POLICY_DECISION_ASK,
    "exit_plan_mode": POLICY_DECISION_ASK,
    # `verify` runs one of the user's own saved Workspace Test Runner
    # configurations. Its descriptor is honestly side-effecting (tests write
    # snapshots and coverage), but the model chooses only WHICH saved config to
    # run and can never author the command, so it defaults to auto rather than
    # prompting on every verification. User policy rules still override.
    "verify": POLICY_DECISION_AUTO,
    # Side-effecting: writes one PNG into the session artifact store and parks the
    # chat engine for the render, but bounded to the user's own installed engine
    # and saved model set; nothing leaves the machine.
    "image_generate": POLICY_DECISION_AUTO,
    # Durable task-board writes have the same bounded, user-owned Open Loops
    # safety posture as the Electron-side Home actions.
    "task_board": POLICY_DECISION_AUTO,
    # Project-note writes touch only the user's own per-project note, are
    # bounded, attributed to the assistant and one-click undoable.
    "project_notes": POLICY_DECISION_AUTO,
    # The in-session todo list is the model's own scratch state; approval is
    # for the user's files and commands (owner, 2026-09-22).
    "todo_write": POLICY_DECISION_AUTO,
    # Jenny's memory: bounded, attributed to Jenny, suppressible and one-click
    # undoable; consent rides the per-request memory policy, not a prompt.
    "memory": POLICY_DECISION_AUTO,
    "conversations_recent": POLICY_DECISION_AUTO,
    # Session directory (row 69): reads auto; stopping another chat cancels
    # user-started work, so it asks.
    "sessions_list": POLICY_DECISION_AUTO,
    "session_status": POLICY_DECISION_AUTO,
    "session_transcript": POLICY_DECISION_AUTO,
    "session_stop": POLICY_DECISION_ASK,
    # Row 88: reading the allowlisted settings is free; every change asks.
    "settings_get": POLICY_DECISION_AUTO,
    "settings_change": POLICY_DECISION_ASK,
    # Row 94 P1: Jenny organizes chats (ask; Auto skips) and reconfigures them (always a card).
    "chat_organize": POLICY_DECISION_ASK,
    "chat_configure": POLICY_DECISION_ASK,
    # Row 94 P2: listing projects is free; creating one binds a folder (always a card).
    "project_create": POLICY_DECISION_ASK,
    "projects_list": POLICY_DECISION_AUTO,
    # Row 94 P3: moving the view writes nothing; the renderer asks with a chip when the user
    # is busy.
    "app_view": POLICY_DECISION_AUTO,
    # Row 94 P4: an export writes a file and terminal_run types into the user's terminal (both
    # always a card); reading the terminal is free.
    "session_export": POLICY_DECISION_ASK,
    "terminal_read": POLICY_DECISION_AUTO,
    "terminal_run": POLICY_DECISION_ASK,
    # Row 85: listing scheduled checks is free; every change asks (always a card).
    "schedule_list": POLICY_DECISION_AUTO,
    "schedule_change": POLICY_DECISION_ASK,
    # Row 86: reading the facts since the user was last present is free (read-only, no card).
    "away_digest": POLICY_DECISION_AUTO,
    # Row 69 W4b: reads the bundled app guide only.
    "jenny_help": POLICY_DECISION_AUTO,
    # Row 97: records a next-step card for the renderer; no I/O, never waits.
    "suggest_next_step": POLICY_DECISION_AUTO,
    "conversation_open": POLICY_DECISION_AUTO,
    "conversations_search": POLICY_DECISION_AUTO,
}
_WINDOWS_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:($|[\\/])")
_UNC_PATH_RE = re.compile(r"^[\\/]{2}[^\\/]+[\\/][^\\/]+")


def _descriptor_name(descriptor: Any) -> str:
    return str(getattr(descriptor, "name", "") or "").strip()


def _policy_tool_ids_for_descriptor(descriptor_name: str) -> tuple[str, ...]:
    if descriptor_name == "delegate":
        return _DELEGATE_COMPATIBILITY_TOOL_IDS
    return (descriptor_name,)


def _legacy_policy_for_descriptor(
    snapshot: ToolPolicySnapshot,
    descriptor_name: str,
    action: str = "",
) -> tuple[str, str] | None:
    selected: tuple[str, str] | None = None
    if action and ":" not in descriptor_name:
        for tool_name in _policy_tool_ids_for_descriptor(descriptor_name):
            composite_name = f"{tool_name}:{action}"
            decision = snapshot.legacy_decision_for(composite_name)
            if decision not in _VALID_POLICY_DECISIONS:
                continue
            if selected is None or (
                _LEGACY_POLICY_DECISION_PRIORITY[decision]
                > _LEGACY_POLICY_DECISION_PRIORITY[selected[1]]
            ):
                selected = (composite_name, decision)
        if selected is not None:
            return selected
    for tool_name in _policy_tool_ids_for_descriptor(descriptor_name):
        decision = snapshot.legacy_decision_for(tool_name)
        if decision not in _VALID_POLICY_DECISIONS:
            continue
        if selected is None or (
            _LEGACY_POLICY_DECISION_PRIORITY[decision]
            > _LEGACY_POLICY_DECISION_PRIORITY[selected[1]]
        ):
            selected = (tool_name, decision)
    return selected


def _descriptor_family(descriptor: Any) -> str:
    return str(getattr(descriptor, "tool_family", "") or "").strip()


def _descriptor_source_kind(descriptor: Any) -> str:
    return str(getattr(descriptor, "source_kind", "") or "").strip()


def _descriptor_server_name(descriptor: Any) -> str:
    return str(getattr(descriptor, "server_name", "") or "").strip()


def _path_argument(arguments: dict[str, Any]) -> str:
    value = arguments.get("path")
    if value is None:
        value = arguments.get("file_path")
    return str(value or "").strip()


def _is_windows_like_policy_path(value: str) -> bool:
    return (
        "\\" in value
        or _WINDOWS_DRIVE_PATH_RE.match(value) is not None
        or _UNC_PATH_RE.match(value) is not None
    )


def _strip_trailing_policy_separators(value: str) -> str:
    out = value
    while len(out) > 1 and out.endswith("/") and re.match(r"^[a-z]:/$", out, re.IGNORECASE) is None:
        out = out[:-1]
    return out


def _normalize_policy_path_for_match(value: str, *, windows_like: bool) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    normalizer = ntpath.normpath if windows_like else posixpath.normpath
    normalized = normalizer(raw).replace("\\", "/")
    if not windows_like and normalized.startswith("//"):
        # posixpath.normpath keeps exactly two leading slashes (POSIX leaves
        # "//" implementation-defined); the JS evaluator collapses them, so
        # "//etc" must match a "/etc" rule here as well (tool review C1 #7).
        normalized = normalized[1:]
    if windows_like:
        normalized = normalized.casefold()
        if re.match(r"^[a-z]:\.?$", normalized, re.IGNORECASE):
            return f"{normalized[0]}:/"
    return _strip_trailing_policy_separators(normalized)


def _is_root_policy_prefix(value: str) -> bool:
    return value == "/" or re.match(r"^[a-z]:/$", value, re.IGNORECASE) is not None


def _path_prefix_matches(path_value: str, prefix_value: str) -> bool:
    raw_path = str(path_value or "").strip()
    raw_prefix = str(prefix_value or "").strip()
    if not raw_path or not raw_prefix:
        return False
    windows_like = _is_windows_like_policy_path(raw_path) or _is_windows_like_policy_path(
        raw_prefix
    )
    normalized_path = _normalize_policy_path_for_match(
        raw_path,
        windows_like=windows_like,
    )
    normalized_prefix = _normalize_policy_path_for_match(
        raw_prefix,
        windows_like=windows_like,
    )
    if not normalized_path or not normalized_prefix:
        return False
    return (
        normalized_path == normalized_prefix
        or (
            _is_root_policy_prefix(normalized_prefix)
            and normalized_path.startswith(normalized_prefix)
        )
        or normalized_path.startswith(f"{normalized_prefix}/")
    )


def _rule_matches(
    rule: ToolPolicyRule,
    *,
    descriptor: Any,
    arguments: dict[str, Any],
    mode: str,
) -> bool:
    match = rule.match
    return all(
        (
            not match.tool_id
            or match.tool_id in _policy_tool_ids_for_descriptor(_descriptor_name(descriptor)),
            # Electron-authored rules are scoped by tool_id; matching uses the raw call argument.
            not match.action or match.action == str(arguments.get("action") or ""),
            not match.tool_family or match.tool_family == _descriptor_family(descriptor),
            not match.source_kind or match.source_kind == _descriptor_source_kind(descriptor),
            not match.mcp_server or match.mcp_server == _descriptor_server_name(descriptor),
            not match.mode or str(mode or "") in match.mode,
            not match.path_prefix
            or _path_prefix_matches(_path_argument(arguments), match.path_prefix),
            # Row 103: a command rule only ever matches run_command's own argument.
            _command_rule_matches(match, descriptor=descriptor, arguments=arguments),
        )
    )


def _command_rule_matches(match: Any, *, descriptor: Any, arguments: dict[str, Any]) -> bool:
    # `is None`, never truthiness: an empty key must not read as "no command key" (whole tool).
    if match.command_prefix is None and match.command_exact is None:
        return True
    if _descriptor_name(descriptor) != "run_command":
        return False
    command = arguments.get("command")
    prefix = match.command_prefix
    if prefix is not None and not command_matches_prefix(command, prefix):
        return False
    return match.command_exact is None or command_matches_exact(command, match.command_exact)


def _first_rule_hit(
    rules: tuple[ToolPolicyRule, ...],
    *,
    descriptor: Any,
    arguments: dict[str, Any],
    mode: str,
) -> ToolPolicyRule | None:
    first_auto: ToolPolicyRule | None = None
    first_ask: ToolPolicyRule | None = None
    for rule in rules:
        if not _rule_matches(rule, descriptor=descriptor, arguments=arguments, mode=mode):
            continue
        if rule.decision == POLICY_DECISION_DENY:
            return rule
        if rule.decision == POLICY_DECISION_AUTO and first_auto is None:
            first_auto = rule
        elif rule.decision == POLICY_DECISION_ASK and first_ask is None:
            first_ask = rule
    return first_auto or first_ask
