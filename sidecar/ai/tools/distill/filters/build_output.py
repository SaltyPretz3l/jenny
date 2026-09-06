"""Filter for compiler/build output (tsc / cargo build / go build / make / …).

Keeps error/warning/diagnostic lines; collapses the "Compiling …" progress
parade. Biased to keep.
"""

from __future__ import annotations

import re

from sidecar.ai.tools.distill.filters.base import (
    DistillOutput,
    command_selects_program,
    distill_lines,
    normalize_command,
)

_COMMAND_TOKENS = (
    "tsc",
    "cargo build",
    "cargo check",
    "go build",
    "make",
    "webpack",
    "vite build",
    "rollup",
    "esbuild",
    "gradle build",
    "mvn compile",
    "mvn package",
    "cmake",
    "gcc",
    "g++",
    "clang",
    "rustc",
    "dotnet build",
    "msbuild",
    "ninja",
)

_CONTENT_RE = re.compile(
    r"error TS\d+"
    r"|error\[E?\d+\]"
    r"|\bCompiling\b"
    r"|Build failed"
    r"|Finished (dev|release|`?dev`?|`?release`?)"
    r"|could not compile",
    re.IGNORECASE,
)

_KEEP_RE = re.compile(
    r"error|warn|fail|fatal|cannot|unresolved|undefined reference|panic"
    r"|error TS\d+|error\[",
    re.IGNORECASE,
)

# Cargo/clang code-frame pointer lines that give the error its location context.
_POINTER_RE = re.compile(r"^\s*(-->|\^+|\|)")


class BuildOutputFilter:
    name = "build_output"

    def matches(self, *, command: str, content: str) -> bool:
        norm = normalize_command(command)
        if command_selects_program(norm, _COMMAND_TOKENS):
            return True
        return bool(_CONTENT_RE.search(content))

    def distill(self, raw: str) -> DistillOutput:
        return distill_lines(raw, keep_line=self._keep)

    @staticmethod
    def _keep(line: str) -> bool:
        return bool(_KEEP_RE.search(line)) or bool(_POINTER_RE.search(line))
