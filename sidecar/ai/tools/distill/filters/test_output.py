"""Filter for test-runner output (pytest / jest / vitest / go test / …).

Keeps failure, assertion, traceback and summary lines; collapses the pass /
progress parade. Biased to keep — over-keeping is safe, dropping an error is not.
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
    "pytest",
    "py.test",
    "jest",
    "vitest",
    "mocha",
    "jasmine",
    "go test",
    "cargo test",
    "npm test",
    "npm run test",
    "yarn test",
    "pnpm test",
    "unittest",
    "rspec",
    "phpunit",
    "gradle test",
    "mvn test",
)

_CONTENT_RE = re.compile(
    r"test session starts"
    r"|collected \d+ items?"
    r"|short test summary"
    r"|=+ FAILURES =+"
    r"|Test Suites?:"
    r"|Ran \d+ tests?"
    r"|--- (FAIL|PASS):"
    r"|\b\d+ (passed|failed)\b",
    re.IGNORECASE,
)

_KEEP_RE = re.compile(
    r"fail|error|assert|traceback|panic|exception|✕|✗|✘|●",
    re.IGNORECASE,
)

_SUMMARY_RE = re.compile(
    r"^[=_\-]{3,}.*[=_\-]{3,}$"  # pytest banners / failure headers
    r"|\b\d+\s+(passed|failed|error|errors|skipped|deselected|xfailed|xpassed|warnings?)\b"
    r"|^\s*(tests?|test suites?):",  # jest summary
    re.IGNORECASE,
)

_TEST_FAILURE_HEADLINE_RE = re.compile(
    r"^\s*not ok\b"
    r"|^\s*(?:ERR_ASSERTION|AssertionError|Error:)\b"
    r"|^\s*(?:FAIL|FAILED)(?:\s|:)"
    r"|\bexit code\s*[:=]?\s*-?\d+\b",
    re.IGNORECASE,
)

_TRACEBACK_HEADER_RE = re.compile(r"^Traceback \(most recent call last\):\s*$")


class TestOutputFilter:
    name = "test_output"

    def matches(self, *, command: str, content: str) -> bool:
        norm = normalize_command(command)
        if command_selects_program(norm, _COMMAND_TOKENS):
            return True
        return bool(_CONTENT_RE.search(content))

    def distill(self, raw: str) -> DistillOutput:
        in_traceback = False

        def keep_line(line: str) -> bool:
            nonlocal in_traceback
            if _TRACEBACK_HEADER_RE.match(line):
                in_traceback = True
                return True
            if in_traceback:
                if line and not line[0].isspace():
                    in_traceback = False
                return True
            return self._keep(line)

        return distill_lines(raw, keep_line=keep_line)

    @staticmethod
    def _keep(line: str) -> bool:
        return (
            bool(_KEEP_RE.search(line))
            or bool(_SUMMARY_RE.search(line))
            or bool(_TEST_FAILURE_HEADLINE_RE.search(line))
        )
