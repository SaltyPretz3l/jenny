"""Neutralize wire-level prompt markers embedded in tool output.

Threat model
------------
Tool output is derived from untrusted sources (fetched HTML, web search
results, file contents, subprocess stdout).  If an attacker can embed
the literal wire-level markers Jenny's prompt pipeline uses to
separate cache boundaries or role turns, they can split a single tool
result into what *looks like* a new role turn or a new cache segment
once the string is folded back into the next prompt.

The existing :mod:`sidecar.ai.tools.sanitization` pipeline already
rewrites ChatML / Llama3 / Gemma role tokens to ``[TOKEN_REDACTED]``.
This module covers the markers that sanitization does **not** touch
because they look like ordinary HTML/text:

* ``<!-- CACHE_BOUNDARY -->`` — used by :mod:`sidecar.ai.context.prompt_cache`
  to split the cacheable prefix from the dynamic suffix.  An injected
  boundary would let an attacker influence where the next cache split
  happens, either inflating cost (force recompute) or pushing
  attacker-controlled content into the "cacheable" (long-lived)
  region.
* Llama ``<<SYS>>`` / ``<</SYS>>`` — role separators used by some
  local models.  Already partially covered in sanitization's special
  token list via ``[/?INST]``, but the ``<<SYS>>`` variant is distinct
  and is not in the existing regex.

Guarantees
----------
* Idempotent: running twice produces the same output as running once.
* Non-destructive: the content is *escaped*, not deleted — the tool
  result remains diagnosable in logs and to the model.
* Single-pass O(n): one linear scan per regex.
* Strict typing: non-``str`` input raises ``TypeError`` so silent
  drops never hide a mismatched pipeline.
"""

from __future__ import annotations

import re

from sidecar.ai.context.prompt_cache import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

_CACHE_BOUNDARY_RE = re.compile(
    r"<!--\s*CACHE_BOUNDARY\s*-->",
    re.IGNORECASE,
)
_CACHE_BOUNDARY_ESCAPED = SYSTEM_PROMPT_DYNAMIC_BOUNDARY.replace("-->", "(escaped) -->")

_LLAMA_SYS_OPEN_RE = re.compile(r"<<\s*SYS\s*>>", re.IGNORECASE)
_LLAMA_SYS_CLOSE_RE = re.compile(r"<<\s*/\s*SYS\s*>>", re.IGNORECASE)
_LLAMA_SYS_OPEN_ESCAPED = "[SYS_OPEN_ESCAPED]"
_LLAMA_SYS_CLOSE_ESCAPED = "[SYS_CLOSE_ESCAPED]"

_ANY_MARKER_RE = re.compile(r"CACHE_BOUNDARY|<<\s*/?\s*SYS", re.IGNORECASE)


def neutralize_prompt_markers(text: str) -> str:
    """Escape wire-level prompt markers in *text*.

    The function is intentionally narrow: it only rewrites markers that
    would alter prompt-assembly semantics downstream (cache boundaries,
    Llama system-role delimiters).  Generic prompt-injection filtering
    and ChatML token stripping already live in
    :mod:`sidecar.ai.tools.sanitization`; this module runs alongside
    that pipeline, not in place of it.

    Parameters
    ----------
    text:
        The tool output string to sanitize.

    Returns
    -------
    str
        A new string with prompt markers escaped.  Idempotent.

    Raises
    ------
    TypeError
        If *text* is not a ``str``.
    """
    if not isinstance(text, str):
        raise TypeError(f"neutralize_prompt_markers expects str, got {type(text).__name__}")
    if not _ANY_MARKER_RE.search(text):
        return text
    out = _CACHE_BOUNDARY_RE.sub(_CACHE_BOUNDARY_ESCAPED, text)
    out = _LLAMA_SYS_CLOSE_RE.sub(_LLAMA_SYS_CLOSE_ESCAPED, out)
    out = _LLAMA_SYS_OPEN_RE.sub(_LLAMA_SYS_OPEN_ESCAPED, out)
    return out
