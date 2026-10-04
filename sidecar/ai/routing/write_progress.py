"""Reads-without-writes tracking for approved-plan execution (TR-015).

A slow local model can spend a whole turn re-reading files and drafting code in
reasoning that the loop never replays, so nothing is ever saved. This pure
tracker counts successful read-class tool calls since the last successful write
and, past a limit, produces one recency-end nudge telling the model to save a
small piece now. It performs no I/O; the loop decides when it applies.

The G5 re-check showed one advisory nudge is not enough: the model acknowledged
it and kept verifying through scripts and commands. The escalation
(``JENNY_ENABLE_WRITE_PROGRESS_ESCALATION=0`` disables it) counts commands that
changed nothing as reads, follows an ignored nudge with a directive naming the
most-read file, and re-pins the unanswered instruction after compaction. When
the directive is ignored too, the tool gate
(``JENNY_ENABLE_WRITE_PROGRESS_TOOL_GATE=0`` disables it) offers only
write_file/edit_file for one generation step.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.routing.tool_execution_results import side_effecting_by_tool
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

__all__ = (
    "ESCALATION_FLAG",
    "IGNORED_CALLS_BEFORE_ESCALATION",
    "MAX_WRITE_PROGRESS_NUDGES",
    "READS_WITHOUT_WRITE_LIMIT",
    "TOOL_GATE_FLAG",
    "WriteProgress",
    "append_write_progress_nudge",
    "gated_generation_payload",
    "nudge_applies",
    "repin_after_compaction",
    "write_progress_nudge_row",
)

READS_WITHOUT_WRITE_LIMIT = 12
MAX_WRITE_PROGRESS_NUDGES = 2
# Non-write calls after an instruction before the next rung, and per-turn caps.
IGNORED_CALLS_BEFORE_ESCALATION = 3
MAX_DIRECTIVES = 2
MAX_TOOL_GATES = 2
ESCALATION_FLAG = "JENNY_ENABLE_WRITE_PROGRESS_ESCALATION"
TOOL_GATE_FLAG = "JENNY_ENABLE_WRITE_PROGRESS_TOOL_GATE"
_GATE_TOOLS = frozenset({"write_file", "edit_file"})

# Only a typed file mutation proves a save. A shell or Python command resets the
# streak solely on explicit change evidence in its metadata or a foreground
# worktree observation that saw changed paths: ``git status`` through
# run_command is a read in disguise and must not erase the count. The probe's
# ``source_changed`` wins over ``workspace_changed`` when present, so ``git add``,
# a stray ``cfile=none`` or an untracked data folder is not a save either.
_FILE_MUTATION_TOOLS = frozenset({
    "write_file",
    "edit_file",
    "move_file",
    "delete_file",
    "create_artifact",
})
_COMMAND_TOOLS = frozenset({"run_command", "run_temp_script", "python_execute"})
# Flag-gated tools are absent from the default registry, so the read-class set
# is named explicitly beside the registry's side-effect map.
_READ_CLASS_TOOLS = frozenset({
    "read_file",
    "grep_search",
    "glob_files",
    "list_dir",
    "git_status",
    "git_log",
    "git_show",
    "git_diff",
    "workspace_manifest_read",
    "todo_read",
    "tool_search",
})
_READ_CLASS_PREFIXES = ("lsp_",)

_NUDGE_TEMPLATE = (
    "You have made {count} read-only tool calls since your last file write while the "
    "approved plan still has open work. You already have enough context: if code "
    "remains to be written for the current todo, your next tool call should be "
    "write_file (new file) or edit_file, saving one small piece (one function or up "
    "to ~150 lines), then run the tests that touch it. Do not re-read a file you "
    "already read in this turn unless an edit to it fails, and do not draft whole "
    "modules in your reasoning before writing."
)
# Worded after the owner prompt that finally produced a write in G5 ("your first
# tool call is the edit"): an instruction naming the action, not advice.
_DIRECTIVE_TEMPLATE = (
    "You were told to save your work and have made {count} more tool calls without "
    "writing anything. Stop verifying: you already have the diagnosis. Your next tool "
    "call must be edit_file (or write_file for a new file){target}, applying the change "
    "you already derived for the current step of the approved plan. Run the tests "
    "after the edit, not before."
)
_GATE_TEMPLATE = (
    "For this one step only write_file and edit_file are available. Save the change "
    "you already derived{target} now; the other tools return after this step."
)


def _template_pattern(template: str) -> re.Pattern[str]:
    parts = re.split(r"\{\w+\}", template)
    return re.compile(".*?".join(re.escape(part) for part in parts), re.DOTALL)


# Rehydration recognises the rows this module already sent from their text.
_NUDGE_ROW = _template_pattern(_NUDGE_TEMPLATE)
_DIRECTIVE_ROW = _template_pattern(_DIRECTIVE_TEMPLATE)
_GATE_ROW = _template_pattern(_GATE_TEMPLATE)


def _flag_enabled(name: str) -> bool:
    return read_environment_value(name, "1") != "0"


def _is_write(outcome: Any, tool_name: str) -> bool:
    if tool_name in _FILE_MUTATION_TOOLS:
        return True
    if tool_name not in _COMMAND_TOOLS:
        return False
    metadata = getattr(outcome, "metadata", None)
    if not isinstance(metadata, dict):
        return False
    if "source_changed" in metadata:
        return metadata["source_changed"] is True
    return metadata.get("workspace_changed") is True or _observed_change(
        metadata.get("worktree_observation")
    )


def _observed_change(observation: object) -> bool:
    if not isinstance(observation, dict):
        return False
    changed = observation.get("changed_path_count")
    return (
        observation.get("certainty") == "observed_during_call"
        and isinstance(changed, int)
        and changed > 0
    )


def _is_read(tool_name: str, side_effecting: dict[str, bool], *, commands: bool) -> bool:
    if tool_name in _COMMAND_TOOLS:
        return commands
    return (
        tool_name in _READ_CLASS_TOOLS
        or tool_name.startswith(_READ_CLASS_PREFIXES)
        or side_effecting.get(tool_name) is False
    )


def _read_path(outcome: Any, tool_name: str) -> str:
    tool_input = getattr(outcome, "tool_input", None)
    path = tool_input.get("path") if isinstance(tool_input, dict) else None
    return path.strip() if tool_name == "read_file" and isinstance(path, str) else ""


@dataclass
class WriteProgress:
    """Per-turn count of successful reads since the last successful write.

    ``outstanding`` is the newest instruction the model has not answered with a
    write; ``stalls_since_nudge`` counts the non-write calls made since it.
    """

    reads_since_write: int = 0
    nudges_sent: int = 0
    escalate: bool = True
    tool_gate: bool = True
    outstanding: str | None = None
    stalls_since_nudge: int = 0
    rung: int = 0
    directives_sent: int = 0
    gates_sent: int = 0
    gate_next_step: bool = False
    read_paths: Counter[str] = field(default_factory=Counter)

    @classmethod
    def from_environment(cls) -> WriteProgress:
        escalate = _flag_enabled(ESCALATION_FLAG)
        return cls(escalate=escalate, tool_gate=escalate and _flag_enabled(TOOL_GATE_FLAG))

    def observe(self, outcomes: Iterable[Any]) -> None:
        """Fold tool outcomes in order; failed calls neither count nor reset."""
        side_effecting = side_effecting_by_tool()
        for outcome in outcomes:
            if getattr(outcome, "success", False) is not True:
                continue
            tool_name = str(getattr(outcome, "tool_name", "") or "")
            if _is_write(outcome, tool_name):
                self.reads_since_write = self.stalls_since_nudge = self.rung = 0
                self.outstanding = None
                self.gate_next_step = False
            elif _is_read(tool_name, side_effecting, commands=self.escalate):
                self.reads_since_write += 1
                self.stalls_since_nudge += 1
                path = _read_path(outcome, tool_name)
                if path:
                    self.read_paths[path] += 1

    def rehydrate(self, outcomes: Sequence[Any], messages: Iterable[Any]) -> None:
        """Rebuild the turn's state on a run resumed after an approval.

        Every approval resume builds a new loop run, so the tracker is folded
        again from what the run carries: *outcomes* since the plan approval and
        the instruction rows already in *messages*. Tool rows after the newest
        instruction mark the calls made since it. The tool gate is never armed
        here; it stays a fresh decision.
        """
        last_text: str | None = None
        tool_rows_after = escalations = 0
        for message in messages:
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            if message.get("role") == "tool":
                tool_rows_after += 1
            elif isinstance(content, str) and (kind := _instruction_kind(content)):
                last_text, tool_rows_after = content, 0
                self.nudges_sent += kind == "nudge"
                self.directives_sent += kind == "directive"
                self.gates_sent += kind == "gate"
                escalations = 0 if kind == "nudge" else escalations + 1
        if last_text is None:
            self.observe(outcomes)
            return
        split = max(len(outcomes) - tool_rows_after, 0)
        self.observe(outcomes[:split])
        self.outstanding, self.rung = last_text, escalations
        self.reads_since_write = self.stalls_since_nudge = 0
        self.observe(outcomes[split:])

    def next_text(self) -> str | None:
        """The next rung when an outstanding instruction was ignored, else the nudge."""
        if (
            self.escalate
            and self.outstanding is not None
            and self.stalls_since_nudge >= IGNORED_CALLS_BEFORE_ESCALATION
        ):
            return self._escalation_text()
        return self.nudge_text()

    def _escalation_text(self) -> str | None:
        count, self.stalls_since_nudge = self.stalls_since_nudge, 0
        most_read = self.read_paths.most_common(1)
        path = most_read[0][0] if most_read else ""
        if self.rung >= 1 and self.tool_gate and self.gates_sent < MAX_TOOL_GATES:
            text = _GATE_TEMPLATE.format(target=f" to {path}" if path else "")
            self.gates_sent += 1
            self.gate_next_step = True
        elif self.directives_sent < MAX_DIRECTIVES:
            text = _DIRECTIVE_TEMPLATE.format(count=count, target=f" on {path}" if path else "")
            self.directives_sent += 1
        else:
            return None
        self.rung += 1
        self.outstanding = text
        return text

    def nudge_text(self) -> str | None:
        """The nudge once the read streak hits the limit (at most twice a turn).

        Sending a nudge restarts the streak, so the next one needs another full
        ``READS_WITHOUT_WRITE_LIMIT`` reads.
        """
        if (
            self.reads_since_write < READS_WITHOUT_WRITE_LIMIT
            or self.nudges_sent >= MAX_WRITE_PROGRESS_NUDGES
        ):
            return None
        text = _NUDGE_TEMPLATE.format(count=self.reads_since_write)
        self.nudges_sent += 1
        self.reads_since_write = self.stalls_since_nudge = self.rung = 0
        self.outstanding = text
        return text


def _instruction_kind(content: str) -> str | None:
    for kind, pattern in (
        ("nudge", _NUDGE_ROW), ("directive", _DIRECTIVE_ROW), ("gate", _GATE_ROW)
    ):
        if pattern.fullmatch(content):
            return kind
    return None


def _since_plan_approval(outcomes: Sequence[Any]) -> Sequence[Any]:
    """Outcomes after the last successful exit_plan_mode: planning reads never count."""
    for index in range(len(outcomes) - 1, -1, -1):
        outcome = outcomes[index]
        if (
            getattr(outcome, "tool_name", "") == "exit_plan_mode"
            and getattr(outcome, "success", False) is True
        ):
            return outcomes[index + 1:]
    return outcomes


def nudge_applies(loop: Any) -> bool:
    """Approved-plan build turns only: never Plan Mode, read-only, Q&A or exploration.

    A carried approved plan (todos still open on a later prompt) counts: that is
    exactly the "continue" turn where the zero-write loop happened. The nudge
    wording is conditional on work remaining, so an explanation-only prompt
    during an unfinished build gets one ignorable row at worst.
    """
    if getattr(loop, "plan_mode", False) or getattr(loop, "read_only", False):
        return False
    context = getattr(loop, "request_context", None)
    if not (
        getattr(context, "approved_plan", None)
        or getattr(context, "plan_approved_in_turn", False)
    ):
        return False
    available = set(getattr(getattr(loop, "tool_contract", None), "available_names", ()))
    return bool(available & {"write_file", "edit_file"})


def write_progress_nudge_row(
    loop: Any, new_outcomes: Iterable[Any]
) -> dict[str, object] | None:
    """Fold one batch of outcomes into the loop's tracker; the nudge row when due.

    The tracker lives on *loop* and is created on first use, rehydrated from
    the outcomes and messages the run carries (an approval resume is a new run;
    the batch's own tool rows are already in the messages, so it is folded with
    them). Outside an approved-plan build the batch is ignored entirely.
    """
    if not nudge_applies(loop):
        return None
    tracker = getattr(loop, "_write_progress", None)
    if tracker is None:
        tracker = loop._write_progress = WriteProgress.from_environment()
        batch = list(new_outcomes)
        carried = list(getattr(loop, "outcomes", None) or ())
        prior = carried[: max(len(carried) - len(batch), 0)]
        tracker.rehydrate(_since_plan_approval([*prior, *batch]), loop.working_messages)
    else:
        tracker.observe(new_outcomes)
    reads_since_write = tracker.reads_since_write
    calls_since_nudge = tracker.stalls_since_nudge
    rung_before = tracker.rung
    text = tracker.next_text()
    if text is None:
        return None
    escalated = tracker.rung > rung_before
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event=(
            "ai.router.write_progress_escalation" if escalated
            else "ai.router.write_progress_nudge"
        ),
        message=(
            "Escalated an ignored instruction to save work." if escalated
            else "Nudged the model to save its work after a read-only streak."
        ),
        status="nudged",
        data={
            "reads_since_write": reads_since_write,
            "calls_since_nudge": calls_since_nudge if escalated else 0,
            "rung": tracker.rung,
            "tool_gate_armed": tracker.gate_next_step,
            "nudges_sent": tracker.nudges_sent,
        },
    )
    return {"role": "system", "content": text}


def append_write_progress_nudge(loop: Any, new_outcomes: Iterable[Any]) -> None:
    """Append the nudge row to the loop's working messages when one is due.

    Called once per tool phase, after any failure context, so the nudge is the
    newest instruction the model reads (the loop file sits at its size ceiling,
    hence the one-line seam there).
    """
    row = write_progress_nudge_row(loop, new_outcomes)
    if row is not None:
        loop.working_messages.append(row)


def _schema_name(schema: Any) -> str:
    if not isinstance(schema, dict):
        return ""
    function = schema.get("function")
    return str((function if isinstance(function, dict) else schema).get("name") or "")


def gated_generation_payload(loop: Any, payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Consume an armed tool gate: one generation offered only write_file/edit_file.

    The gate never empties the payload: without a write schema the step keeps
    its ordinary tools.
    """
    tracker = getattr(loop, "_write_progress", None)
    if tracker is None or not tracker.gate_next_step:
        return payload
    tracker.gate_next_step = False
    gated = [schema for schema in payload if _schema_name(schema) in _GATE_TOOLS]
    if not gated:
        return payload
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.write_progress_tool_gate",
        message="Offered only write tools for one step after ignored save instructions.",
        status="gated",
        data={
            "offered": [_schema_name(schema) for schema in gated],
            "withheld": len(payload) - len(gated),
        },
    )
    return gated


def repin_after_compaction(loop: Any) -> None:
    """Re-append the unanswered instruction after compaction rebuilt the messages.

    The mid-turn window keeps only the newest rows, so an instruction a few
    calls old is summarised away; the summary's Next Step then carries the
    model's own "verify first" intent instead.
    """
    tracker = getattr(loop, "_write_progress", None)
    text = getattr(tracker, "outstanding", None)
    if not text or not getattr(tracker, "escalate", False):
        return
    messages = loop.working_messages
    if messages and messages[-1].get("content") == text:
        return
    messages.append({"role": "system", "content": text})
