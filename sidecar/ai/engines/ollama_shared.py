"""Shared constants and logger for the Ollama engine hub and its mixins."""

from __future__ import annotations

import logging
import re

from sidecar.ai.engines.model_name import supports_ollama_reasoning_levels
from sidecar.ai.engines.ollama_acquisition import (
    ProgressCallback,
    pull_ollama_model,
    report_model_state,
)
from sidecar.ai.engines.ollama_model_info import fetch_ollama_model_info

logger = logging.getLogger("sidecar.ai.engines.ollama")


_DEFAULT_REQUEST_TIMEOUT = 300
# Total wall-clock budget for one `POST /api/pull`, enforced against the
# absolute deadline `_PullDeadline` fixes at construction.
#
# LOAD-BEARING CROSS-PROCESS RELATIONSHIP: services/backend/local-engine-status.js
# sets DEFAULT_ABSOLUTE_TIMEOUT_MS = 615_000 -- this value plus 15s of headroom --
# so the SIDECAR is always the side that gives up first and reports a clean typed
# failure, leaving the Electron watchdog as the backstop for a sidecar that never
# answers at all. Raising this without raising that ceiling inverts the order and
# lets Electron abort a still-running pull, orphaning it.
_PULL_TIMEOUT = 600
_HEALTH_TIMEOUT = 10
_UNLOAD_TIMEOUT = 30
_BAD_REQUEST_STATUS = 400
_MAX_REQUEST_CONTEXT_LENGTH = 1_010_000
_HTTP_STATUS_RE = re.compile(r"HTTP Error (?P<status>\d{3})", re.IGNORECASE)

__all__ = [
    "ProgressCallback",
    "fetch_ollama_model_info",
    "pull_ollama_model",
    "report_model_state",
    "supports_ollama_reasoning_levels",
]
