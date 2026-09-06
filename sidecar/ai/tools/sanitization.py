"""Tool output sanitization helpers."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import unicodedata
from dataclasses import dataclass

from sidecar.ai.tools.prompt_marker_guard import neutralize_prompt_markers

_ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")
_SURROGATE_RE = re.compile("[\ud800-\udfff]")
_NEWLINE_NORMALIZE_RE = re.compile(r"\r\n?")

_INVISIBLE_CHARS_RE = re.compile(
    "["
    "\u00ad"  # soft hyphen
    "\u200b"  # zero-width space
    "\u200c"  # zero-width non-joiner
    "\u200d"  # zero-width joiner
    "\u200e"  # left-to-right mark
    "\u200f"  # right-to-left mark
    "\u2060"  # word joiner
    "\ufeff"  # zero-width no-break space / BOM
    "]"
)

_SPECIAL_TOKENS_RE = re.compile(
    r"(<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>"
    r"|\[/?INST\]|</?s>"
    r"|<\|system\|>|<\|user\|>|<\|assistant\|>"
    # Gemma / Llama 3 / Phi / Qwen control tokens
    r"|<\|tool_response\|?>|<\|tool_call\|?>"
    r"|<\|eot_id\|>|<\|start_header_id\|>|<\|end_header_id\|>"
    r"|<\|end\|>|<\|pad\|>"
    r"|<eos>|<bos>|<pad>"
    r"|<end_of_turn>|<start_of_turn>"
    # Gemma channel / role separator tokens
    r"|<channel\|>|<\|channel\|>)",
    re.IGNORECASE,
)
_VISIBLE_THOUGHT_SENTINEL_RE = re.compile(
    r"(?im)^[ \t]*(?:_?thought|analysis)[ \t:>_-]*",
)
_DATA_URI_RE = re.compile(
    r"\bdata:([a-z0-9.+-]+/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]{256,})",
    re.IGNORECASE,
)
# One block per match, consumed iteratively: a repeated group over lazy
# alternatives backtracks exponentially on long non-matching input.
_TOOL_CALL_BLOCK_RE = re.compile(
    r"<tool_call\b[^>]*>.*?</tool_call>|<function=[^>]+>.*?</function>",
    re.DOTALL | re.IGNORECASE,
)


def _is_tool_call_blocks_only(text: str) -> bool:
    """True when the whole text is one or more tool-call blocks (whitespace between)."""
    stripped = text.strip()
    if not stripped.startswith("<"):
        return False
    position = 0
    while position < len(stripped):
        match = _TOOL_CALL_BLOCK_RE.match(stripped, position)
        if match is None:
            return False
        position = match.end()
        while position < len(stripped) and stripped[position].isspace():
            position += 1
    return True

_SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9]{8,}\b"),
    re.compile(r"\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{16,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(
        r"(?i)\b(api[_-]?key|api-key|authorization|token|secret|password|dsn)"
        r"\s*[:=]\s*(?:Bearer\s+)?([^\s,;'\"{}]+)"
    ),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b"),
    re.compile(
        r"(?i)\b(?:X-Amz-(?:Signature|Credential|Security-Token)|signature|sig)"
        r"\s*[:=]\s*([^\s,;'\"{}&]+)"
    ),
    re.compile(r"\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,}\b"),
)

PROMPT_INJECTION_PATTERNS = (
    (
        "hidden_html_comment",
        re.compile(
            r"(?is)<!--(?=[\s\S]{0,1000}?"
            r"(?:ignore|disregard|reveal|system\s+prompt|developer\s+prompt|"
            r"instructions?|exfiltrat|upload|send|post))[\s\S]*?-->"
        ),
    ),
    (
        "data_exfiltration",
        re.compile(
            r"(?is)\b(?:base64|encode|zip|tar|cat|read|copy|extract)"
            r".{0,120}\b(?:secret|token|password|api[_-]?key|credential|"
            r"\.env|id_rsa|ssh|private\s+key)"
            r".{0,160}\b(?:https?://|post|send|upload|exfiltrat|curl|wget)"
        ),
    ),
    ("ignore_previous", re.compile(r"(?i)ignore\s+all\s+previous\s+instructions")),
    (
        "ignore_prior_rules",
        re.compile(
            r"(?i)(?:ignore|disregard)\s+(?:all\s+)?(?:prior|previous|above)"
            r"\s+(?:instructions|directives|rules)"
        ),
    ),
    ("ignore_system_prompt", re.compile(r"(?i)ignore\s+the\s+system\s+prompt")),
    (
        "reveal_system_prompt",
        re.compile(r"(?i)reveal\s+(?:the\s+)?(?:system|developer)\s+prompt"),
    ),
    ("act_as_system", re.compile(r"(?i)act\s+as\s+system")),
    (
        "pretend_developer",
        re.compile(r"(?i)pretend\s+to\s+be\s+(?:the\s+)?(?:system|developer)"),
    ),
    ("bypass_rules", re.compile(r"(?i)\bdo\s+not\s+follow\s+the\s+rules\b")),
    ("you_are_now", re.compile(r"(?i)\byou\s+are\s+now\b")),
    ("override_instructions", re.compile(r"(?i)(?:new|updated|override)\s+instructions")),
    (
        "new_session",
        re.compile(r"(?i)(?:begin|start)\s+(?:a\s+)?new\s+(?:conversation|session)"),
    ),
    (
        "echo_prior_context",
        re.compile(r"(?i)(?:output|repeat|print)\s+(?:the\s+)?(?:above|previous|system)"),
    ),
    ("role_marker", re.compile(r"\[(?:SYSTEM|USER|ASSISTANT)\]")),
)

_TRUNCATED_SUFFIX = " [truncated]"
_UNTRUSTED_OPEN_TAG = "<untrusted_tool_output>"
_UNTRUSTED_CLOSE_TAG = "</untrusted_tool_output>"


def strip_surrogates(text: str) -> str:
    """Replace unpaired UTF-16 surrogates (U+D800-U+DFFF) with U+FFFD.

    Python strings can contain surrogate codepoints (e.g. from model token
    decoders or Windows ``surrogateescape`` paths), but these cannot be
    encoded as UTF-8 and will crash ``str.encode('utf-8')``.
    """
    return _SURROGATE_RE.sub("\ufffd", text)


def _normalize_whitespace_and_control(text: str) -> str:
    cleaned = _SURROGATE_RE.sub("\ufffd", text)
    cleaned = _ANSI_ESCAPE_RE.sub("", cleaned)
    cleaned = _CONTROL_CHAR_RE.sub("", cleaned)
    return _NEWLINE_NORMALIZE_RE.sub("\n", cleaned)


def strip_invisible_chars(text: str) -> str:
    """Remove zero-width and invisible Unicode characters."""
    return _INVISIBLE_CHARS_RE.sub("", text)


def has_control_tokens(text: str) -> bool:
    """Return ``True`` if *text* contains any known LLM control token."""
    return _SPECIAL_TOKENS_RE.search(text) is not None


def strip_special_tokens(text: str) -> str:
    """Remove known LLM control tokens to prevent model hijacking."""
    return _SPECIAL_TOKENS_RE.sub("[TOKEN_REDACTED]", text)


def drop_special_tokens(text: str) -> str:
    """Silently remove known LLM control tokens from *text*.

    Unlike :func:`strip_special_tokens` (which inserts a ``[TOKEN_REDACTED]``
    placeholder), this variant removes matched tokens entirely.  Use this for
    streaming deltas where placeholders would be visible to the end user.
    """
    return _SPECIAL_TOKENS_RE.sub("", text)


def strip_visible_thought_sentinels(text: str) -> str:
    """Remove local-model thought/channel labels that leaked into visible text."""
    return _VISIBLE_THOUGHT_SENTINEL_RE.sub("", str(text or ""))


_POST_RESPONSE_ANALYSIS_RE = re.compile(
    r"\n{2,}#{1,4}\s*(?:Tool\s+Call|Analysis|Reasoning|Internal|Response)\b",
    re.IGNORECASE,
)
_FUNCTION_RESPONSE_MARKER_RE = re.compile(r"(?im)^[ \t]*function_response[ \t]*$")
_FUNCTION_RESPONSE_MARKER_LITERAL = "function_response"
_FUNCTION_RESPONSE_LOG_EVENT = "ai.tools.sanitization.wrapper_scaffolding_stripped"
_PROMPT_INJECTION_LOG_EVENT = "ai.tools.sanitization.prompt_injection_neutralized"
_TOOL_ARGUMENT_SCAN_LOG_EVENT = "ai.tools.sanitization.tool_arguments_flagged"

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolArgumentScanResult:
    matched: bool
    pattern_families: tuple[str, ...]
    sanitized_preview: str


def _strip_function_response_scaffolding(text: str) -> tuple[str, bool]:
    """Remove leaked wrapper scaffolding like:

    function_response
    { ...json... }

    The removal is conservative: it only triggers when `function_response`
    appears alone on a line and is followed by a parseable JSON object/array.
    """
    if _FUNCTION_RESPONSE_MARKER_LITERAL not in text.lower():
        return text, False

    decoder = json.JSONDecoder()
    cursor = 0
    removed = False
    chunks: list[str] = []

    while True:
        marker = _FUNCTION_RESPONSE_MARKER_RE.search(text, cursor)
        if marker is None:
            break

        marker_start, marker_end = marker.span()
        chunks.append(text[cursor:marker_start])

        json_start = marker_end
        while json_start < len(text) and text[json_start] in " \t\r\n":
            json_start += 1

        if json_start >= len(text) or text[json_start] not in "{[":
            chunks.append(text[marker_start:marker_end])
            cursor = marker_end
            continue

        try:
            parsed, offset = decoder.raw_decode(text[json_start:])
        except json.JSONDecodeError:
            chunks.append(text[marker_start:marker_end])
            cursor = marker_end
            continue

        if not isinstance(parsed, (dict, list)):
            chunks.append(text[marker_start:marker_end])
            cursor = marker_end
            continue

        json_end = json_start + offset
        post = json_end
        while post < len(text) and text[post] in " \t\r\n":
            post += 1

        removed = True
        cursor = post

    if not removed:
        return text, False

    chunks.append(text[cursor:])
    return "".join(chunks), True


def sanitize_assistant_output(output: object, *, max_chars: int = 4000) -> str:
    """Trim assistant-visible output when model control tokens leak into text.

    Assistant replies should never contain raw control tokens. If they appear,
    treat everything from the first control token onward as corrupted output and
    keep only the clean prefix for display/persistence.

    Also strips post-response analysis blocks (e.g. ``### Tool Call Analysis``)
    that some local models append after their actual response.
    """
    raw = str(output or "")
    normalized = _normalize_whitespace_and_control(raw)
    normalized = strip_invisible_chars(normalized)
    normalized = strip_visible_thought_sentinels(normalized)
    first_control = _SPECIAL_TOKENS_RE.search(normalized)
    if first_control is not None:
        normalized = normalized[: first_control.start()]
    analysis_match = _POST_RESPONSE_ANALYSIS_RE.search(normalized)
    if analysis_match is not None:
        normalized = normalized[: analysis_match.start()]
    if _is_tool_call_blocks_only(normalized):
        return ""
    before_wrapper_strip = normalized
    normalized, removed_wrapper = _strip_function_response_scaffolding(normalized)
    if removed_wrapper:
        logger.info(
            "Removed leaked wrapper scaffolding from assistant output.",
            extra={
                "event": _FUNCTION_RESPONSE_LOG_EVENT,
                "component": "ai.tools.sanitization",
                "marker": _FUNCTION_RESPONSE_MARKER_LITERAL,
                "removed_chars": max(len(before_wrapper_strip) - len(normalized), 0),
            },
        )
    redacted = redact_obvious_secrets(normalized.strip())
    return _truncate(redacted, max_chars)


def neutralize_prompt_injection(text: str, *, tool_name: str | None = None) -> str:
    """Best-effort lexical filtering of prompt-injection directives.

    Normalizes to NFKC and strips invisible characters before matching
    so that homoglyph and zero-width bypass techniques are ineffective.
    When a pattern matches, emits a structured, redacted log event with
    the pattern family, content length, and content hash so operators can
    audit repeated attempts without persisting the hostile text itself.
    """
    normalized, matched_families = neutralize_prompt_injection_patterns(text)
    if matched_families:
        content_bytes = normalized.encode("utf-8", errors="replace")
        logger.info(
            "Neutralized prompt injection in tool output.",
            extra={
                "event": _PROMPT_INJECTION_LOG_EVENT,
                "component": "ai.tools.sanitization",
                "tool_name": tool_name or "",
                "pattern_families": matched_families,
                "content_length": len(normalized),
                "content_sha256_prefix": hashlib.sha256(content_bytes).hexdigest()[:16],
            },
        )
    return normalized


def neutralize_prompt_injection_patterns(text: str) -> tuple[str, tuple[str, ...]]:
    """Apply prompt-injection pattern rewrites without emitting log events."""
    normalized = _normalize_prompt_text(text)
    return _apply_prompt_injection_patterns(normalized)


def _normalize_prompt_text(text: str) -> str:
    return strip_invisible_chars(unicodedata.normalize("NFKC", text))


def _apply_prompt_injection_patterns(normalized: str) -> tuple[str, tuple[str, ...]]:
    matched_families: list[str] = []
    for family, pattern in PROMPT_INJECTION_PATTERNS:
        replaced, count = pattern.subn("[FILTERED_INSTRUCTION]", normalized)
        if count > 0:
            matched_families.append(family)
            normalized = replaced
    return normalized, tuple(matched_families)


def redact_obvious_secrets(text: str) -> str:
    """Redact common credential shapes from diagnostic or model-bound text."""
    redacted = text
    for pattern in _SECRET_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def _redact_inline_data_uris(text: str) -> str:
    """Strip large inline base64 data URIs from model-visible tool output."""

    def _replace(match: re.Match[str]) -> str:
        mime_type = match.group(1).lower()
        payload = re.sub(r"\s+", "", match.group(2))
        approx_bytes = max((len(payload) * 3) // 4, 0)
        return f"[INLINE_DATA_URI_STRIPPED]({mime_type}, ~{approx_bytes} bytes)"

    return _DATA_URI_RE.sub(_replace, text)


def _matched_prompt_injection_families_normalized(normalized: str) -> tuple[str, ...]:
    return tuple(
        family
        for family, pattern in PROMPT_INJECTION_PATTERNS
        if pattern.search(normalized) is not None
    )


def _has_secret_pattern(text: str) -> bool:
    return any(pattern.search(text) is not None for pattern in _SECRET_PATTERNS)


def _argument_preview(arguments: object) -> str:
    try:
        return json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(arguments or "")


def scan_tool_arguments(
    arguments: object,
    *,
    tool_name: str | None = None,
    max_preview_chars: int = 500,
) -> ToolArgumentScanResult:
    """Scan model-provided tool arguments before dispatch without mutating them."""
    raw = _argument_preview(arguments)
    normalized = _normalize_whitespace_and_control(raw)
    normalized = _normalize_prompt_text(normalized)
    families = list(_matched_prompt_injection_families_normalized(normalized))
    if _has_secret_pattern(normalized):
        families.append("secret")
    sanitized_preview = sanitize_tool_output(
        normalized,
        max_chars=max_preview_chars,
        tool_name=tool_name,
    )
    unique_families = tuple(dict.fromkeys(families))
    if unique_families:
        logger.info(
            "Flagged suspicious tool arguments before dispatch.",
            extra={
                "event": _TOOL_ARGUMENT_SCAN_LOG_EVENT,
                "component": "ai.tools.sanitization",
                "tool_name": tool_name or "",
                "pattern_families": unique_families,
                "content_length": len(normalized),
                "content_sha256_prefix": hashlib.sha256(
                    normalized.encode("utf-8", errors="replace")
                ).hexdigest()[:16],
            },
        )
    return ToolArgumentScanResult(
        matched=bool(unique_families),
        pattern_families=unique_families,
        sanitized_preview=sanitized_preview,
    )


def _truncate(text: str, max_chars: int) -> str:
    limit = max(1, int(max_chars))
    if len(text) <= limit:
        return text
    if limit <= len(_TRUNCATED_SUFFIX):
        return _TRUNCATED_SUFFIX[:limit]
    return f"{text[: limit - len(_TRUNCATED_SUFFIX)]}{_TRUNCATED_SUFFIX}"


def sanitize_tool_output_no_truncate(
    output: object,
    *,
    tool_name: str | None = None,
) -> str:
    """Everything ``sanitize_tool_output`` does EXCEPT the final ``_truncate``.

    Lets a caller (the tool-output distillation orchestrator) run the full
    redaction pipeline — secrets, injection, data-URIs, special tokens,
    invisible chars — on the *untruncated* text, so distillation shapes and the
    omission store hold only already-redacted bytes.
    """
    raw = str(output or "")
    normalized = _normalize_whitespace_and_control(raw)
    normalized = strip_invisible_chars(normalized)
    normalized = strip_special_tokens(normalized)
    normalized = neutralize_prompt_injection(normalized, tool_name=tool_name)
    # Escape wire-level prompt markers (cache boundary, Llama
    # <<SYS>>/<</SYS>>) that slip past the token/injection regexes.
    normalized = neutralize_prompt_markers(normalized)
    redacted = redact_obvious_secrets(normalized)
    redacted = _redact_inline_data_uris(redacted)
    return redacted


def sanitize_tool_output(
    output: object,
    *,
    max_chars: int = 4000,
    tool_name: str | None = None,
) -> str:
    return _truncate(
        sanitize_tool_output_no_truncate(output, tool_name=tool_name),
        max_chars,
    )


def wrap_untrusted_tool_output(text: str) -> str:
    """Wrap raw tool data in explicit boundaries for model consumption."""
    body = str(text or "")
    return f"{_UNTRUSTED_OPEN_TAG}\n{body}\n{_UNTRUSTED_CLOSE_TAG}"
