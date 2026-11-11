"""Credential redaction for model-bound and diagnostic text.

Two kinds of pattern. Unconditional shapes (provider key prefixes, PEM blocks, URL
userinfo, JWTs, AWS signature parameters) are secrets wherever they appear. Keyword
shapes (`password = ...`, `token: ...`, `signature=...`, `Bearer ...`) are mostly
ordinary code, so they redact only when the value itself looks like a credential:
never identifiers or attribute chains that name code, calls, subscripts, type
annotations, short numbers or placeholders such as `${VAR}` and `<your-token>`.
Names that end in a password, secret or API key take any opaque value, plain words
included (`PASSWORD=swordfish`); `token`, `authorization` and `signature` need a
value with a digit, symbols, or an `Authorization: Bearer` prefix. A separator never
crosses a newline, so `token:` ending a YAML line or a `Signature:` docstring heading
does not swallow the next line. A model that edits a file it read would otherwise
write the `[REDACTED]` marker back into source (benchmark, 2026-11-04).
"""

from __future__ import annotations

import re

REDACTED = "[REDACTED]"

_UNCONDITIONAL_PATTERNS = (
    # Provider keys with dashes/underscores in the body (sk-ant-api03-..., sk-proj-...).
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{8,}\b"),
    re.compile(r"\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{16,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    # PEM private-key blocks, whole.
    # The body never re-enters a header and is bounded (an 8192-bit RSA key is
    # ~6.5 KiB), so thousands of unmatched headers scan linearly.
    re.compile(
        r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S]){0,16384}?"
        r"-----END [A-Z ]{0,40}PRIVATE KEY-----"
    ),
    # URL userinfo: the user:password between the scheme and the host, except the
    # documentation forms `user:pass@host` and `user:<password>@host`.
    re.compile(
        r"(?i)(?<=://)(?!(?:user|username):(?:pass|password)@)"
        r"[^\s/:@]+:(?!(?:\*+|<[^>@]*>)@)[^\s/@]+(?=@)"
    ),
    re.compile(
        r"(?i)\bX-Amz-(?:Signature|Credential|Security-Token)[ \t]*[:=][ \t]*[^\s,;'\"{}&]+"
    ),
    re.compile(r"\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,}\b"),
)

# Named credentials, including JSON/quoted keys and values and compound names such
# as aws_secret_access_key (tool review C7 #3). The match starts at the keyword
# (`aws_` survives, the value never does) and the suffix is bounded: an optional
# prefix group made `token_token_...` cubic.
# Groups: 1 name, 2 Bearer prefix, 3 quote before the value, 4 value.
_NAMED_CREDENTIAL_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9])"
    r"((?:api[_-]?key|api-key|authorization|token|secret|password|passwd|dsn)(?:_[a-z0-9_]{1,48})?)"
    r"[\"']?[ \t]*[:=](?!=)[ \t]*(Bearer[ \t]+)?([\"']?)([^\s,;'\"{}]+)"
)
_SIGNATURE_RE = re.compile(
    r"(?i)\b(signature|sig)[ \t]*[:=](?!=)[ \t]*()([\"']?)([^\s,;'\"{}&]+)"
)
_BEARER_RE = re.compile(r"(?i)\bBearer[ \t]+([A-Za-z0-9._~+/=-]{8,})\b")
# A name whose last part is a password, secret or key holds the secret itself
# (`DB_PASSWORD`, `client_secret`, `aws_secret_access_key`); `API_KEY_FILE_PREFIX`
# and `SECRET_TYPE_SENTRY_DSN` name something else.
_STRONG_NAME_RE = re.compile(r"(?i)(?:pass(?:wd|word)?|secret|key)$")
# Words that mark a value as code or a constant naming the credential, not holding it.
_CODE_STEM_RE = re.compile(r"(?i)pass|pwd|secret|key|token|cred|auth|dsn")

_IDENTIFIER_CHAIN_RE = re.compile(r"[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*")
# Numbers, `1_000_000`, ranges, times, dates, versions, percentages (`1-128`, `09:00`, `36%`).
_NUMERIC_RE = re.compile(r"[-+]?(?:0[xX][0-9a-fA-F_]+|[\d_.:,/%-]+(?:[eE][-+]?\d+)?)")
# Plain words joined by separators: `chat.token`, `sentry_dsn`, `CMP-MESSAGE-0003`.
_WORD_CHAIN_RE = re.compile(r"[._:/-]*(?:[A-Za-z]+|\d+)(?:[._:/-]+(?:[A-Za-z]+|\d+))*[._:/-]?")
_PLACEHOLDER_RE = re.compile(
    r"\$\{\w*\}|\$[A-Z_][A-Z0-9_]*|%\w+%|<[^>]*>?|\*+|(?i:x{3,})|\.{3,}|\{\{.*"
)
_MARKUP_CHARS = frozenset("()[]<>|`")
_MIN_QUOTED_CREDENTIAL = 6
_MIN_OPAQUE = 8
_MIN_LONG_RUN = 20
_MIN_WORDLIKE_BEARER = 24
_NOT_A_VALUE = frozenset(
    {
        "none", "null", "nil", "true", "false", "undefined", "str", "string", "bytes",
        "int", "number", "bool", "boolean", "any", "object", "optional", "required",
        "redacted", "hidden", "bearer", "basic", "digest",
        # Language keywords that start an expression: `apiKey = typeof x`, `token = await f()`.
        "typeof", "await", "new", "lambda", "async", "yield", "not", "void", "function",
        "require", "import", "self", "this", "super", "return",
    }
)


def _is_opaque(value: str) -> bool:
    """Long enough and mixing letters with digits: `!Qaz2wsx`, `/wJalrXUtnFEMI/K7MDENG`."""
    return (
        len(value) >= _MIN_OPAQUE
        and any(char.isdigit() for char in value)
        and any(char.isalpha() for char in value)
    )


def _is_not_a_credential(value: str, strong: bool) -> bool:
    """Sentinels, placeholders, numbers, punctuation and markup tokens such as `[thought]`."""
    if value.lower() in _NOT_A_VALUE or _PLACEHOLDER_RE.fullmatch(value):
        return True
    if _NUMERIC_RE.fullmatch(value):
        # A long digit run under a password name is the password itself.
        return not (strong and sum(char.isdigit() for char in value) >= _MIN_OPAQUE)
    return not any(char.isalnum() for char in value) or any(
        char in _MARKUP_CHARS for char in value
    )


def _unquoted_is_credential(value: str, strong: bool) -> bool:
    if value[0] in "+-!~&*#/" and not _is_opaque(value):
        return False  # `++generation`, `!flag`, a trailing comment
    if _IDENTIFIER_CHAIN_RE.fullmatch(value):
        if "." in value:
            return False  # `self.token`, `config.password`
        if strong:
            # `PASSWORD=swordfish` is a password; `password=password`, `api_key=key`,
            # `secret=entry_text` and short locals are code passing a variable.
            has_digit = any(char.isdigit() for char in value)
            return (
                len(value) >= _MIN_QUOTED_CREDENTIAL
                and "_" not in value.strip("_")
                and (has_digit or not _CODE_STEM_RE.search(value))
            )
        # `hunter2` is a password, `token_budget` is code.
        return any(char.isdigit() for char in value)
    return True  # `api_key=secret-value`, `wJalrXUtnFEMI/K7MDENG`: an opaque literal


def _quoted_is_credential(value: str, strong: bool) -> bool:
    if len(value) < _MIN_QUOTED_CREDENTIAL:
        return False
    if not _WORD_CHAIN_RE.fullmatch(value):
        return True  # `hunter2xx`, `Tr0ub4dor&3`
    if strong:
        # `"swordfish"`, `'django-insecure-abcdef'` are secrets; `'sentry_dsn'` and
        # snake_case values such as `'unknown_server_fields'` are identifier constants.
        return "_" not in value and not _CODE_STEM_RE.search(value)
    return value.isalpha() and len(value) >= _MIN_LONG_RUN


def _looks_like_credential(value: str, quoted: bool, *, strong: bool, bearer: bool) -> bool:
    """True when a keyword's value reads as a literal credential rather than code."""
    if value.startswith(REDACTED):
        return True  # an earlier pattern took the value: keep one marker for key and value
    if _is_not_a_credential(value, strong):
        return False
    if bearer:
        return True  # `Authorization: Bearer abcdefghij`
    if quoted:
        return _quoted_is_credential(value, strong)
    return _unquoted_is_credential(value, strong)


def _looks_like_bearer_token(value: str) -> bool:
    opaque = any(char.isdigit() or char in "._~+/=-" for char in value)
    return (opaque or len(value) >= _MIN_WORDLIKE_BEARER) and value.lower() not in _NOT_A_VALUE


def _credential_replacement(match: re.Match[str]) -> str:
    name, bearer, quote, value = match.groups()
    strong = bool(_STRONG_NAME_RE.search(name))
    if _looks_like_credential(value, bool(quote), strong=strong, bearer=bool(bearer)):
        return REDACTED
    return match.group(0)


def redact_obvious_secrets(text: str) -> str:
    """Redact common credential shapes from diagnostic or model-bound text."""
    redacted = text
    for pattern in _UNCONDITIONAL_PATTERNS:
        redacted = pattern.sub(REDACTED, redacted)
    redacted = _NAMED_CREDENTIAL_RE.sub(_credential_replacement, redacted)
    redacted = _SIGNATURE_RE.sub(_credential_replacement, redacted)
    return _BEARER_RE.sub(
        lambda m: REDACTED if _looks_like_bearer_token(m.group(1)) else m.group(0), redacted
    )


def has_secret_pattern(text: str) -> bool:
    """True when ``redact_obvious_secrets`` would change ``text``."""
    return redact_obvious_secrets(text) != text
