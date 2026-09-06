"""HTML sanitization and HTML-to-markdown conversion helpers."""

from __future__ import annotations

import importlib
import re
import urllib.parse
from html import escape, unescape
from html.parser import HTMLParser

_DROP_CONTENT_TAGS = frozenset(
    {
        "embed",
        "iframe",
        "noscript",
        "object",
        "script",
        "style",
        "svg",
    }
)
_KEEP_ATTRS = frozenset(
    {
        "abbr",
        "align",
        "alt",
        "colspan",
        "headers",
        "href",
        "rowspan",
        "scope",
        "src",
        "title",
    }
)
_SELF_CLOSING_TAGS = frozenset({"br", "hr", "img"})
_SAFE_LINK_SCHEMES = frozenset({"", "http", "https", "mailto"})
_SAFE_IMAGE_SCHEMES = frozenset({"", "http", "https"})
HTML_SANITIZE_MAX_BYTES = 1_048_576

_TEXT_CONTENT_TYPES = frozenset(
    {
        "application/json",
        "application/xhtml+xml",
        "application/xml",
        "text/csv",
        "text/html",
        "text/markdown",
        "text/plain",
        "text/xml",
    }
)


def _is_safe_attr_value(name: str, value: str) -> bool:
    token = str(value or "").strip()
    lowered_name = name.lower()
    if not token:
        return True
    parsed = urllib.parse.urlparse(token)
    scheme = parsed.scheme.lower()
    if lowered_name == "href":
        return scheme in _SAFE_LINK_SCHEMES
    if lowered_name == "src":
        return scheme in _SAFE_IMAGE_SCHEMES
    return True


class _SanitizingHtmlParser(HTMLParser):
    """Rebuild a safe HTML subset for markdown conversion."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self._parts: list[str] = []
        self._drop_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.lower()
        if normalized in _DROP_CONTENT_TAGS:
            self._drop_depth += 1
            return
        if self._drop_depth > 0:
            return
        serialized_attrs = self._serialize_attrs(attrs)
        self._parts.append(f"<{normalized}{serialized_attrs}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.lower()
        if normalized in _DROP_CONTENT_TAGS or self._drop_depth > 0:
            return
        serialized_attrs = self._serialize_attrs(attrs)
        if normalized in _SELF_CLOSING_TAGS:
            self._parts.append(f"<{normalized}{serialized_attrs} />")
            return
        self._parts.append(f"<{normalized}{serialized_attrs}></{normalized}>")

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        if normalized in _DROP_CONTENT_TAGS:
            if self._drop_depth > 0:
                self._drop_depth -= 1
            return
        if self._drop_depth > 0 or normalized in _SELF_CLOSING_TAGS:
            return
        self._parts.append(f"</{normalized}>")

    def handle_data(self, data: str) -> None:
        if self._drop_depth > 0 or not data:
            return
        self._parts.append(escape(data, quote=False))

    def handle_entityref(self, name: str) -> None:
        if self._drop_depth > 0:
            return
        self._parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._drop_depth > 0:
            return
        self._parts.append(f"&#{name};")

    def handle_comment(self, data: str) -> None:
        _ = data

    def get_html(self) -> str:
        return "".join(self._parts)

    @staticmethod
    def _serialize_attrs(attrs: list[tuple[str, str | None]]) -> str:
        pairs: list[str] = []
        for raw_name, raw_value in attrs:
            name = str(raw_name or "").strip().lower()
            if (
                not name
                or name.startswith("on")
                or name in {"style", "srcset"}
                or name not in _KEEP_ATTRS
            ):
                continue
            value = "" if raw_value is None else str(raw_value)
            if not _is_safe_attr_value(name, value):
                continue
            pairs.append(f' {name}="{escape(value, quote=True)}"')
        return "".join(pairs)


def sanitize_html_for_markdown(
    html: str,
    *,
    max_bytes: int = HTML_SANITIZE_MAX_BYTES,
) -> tuple[str, bool]:
    """Return sanitized HTML plus a truncation flag."""
    raw = str(html or "")
    encoded = raw.encode("utf-8", errors="replace")
    truncated = len(encoded) > max_bytes
    limited = encoded[:max_bytes].decode("utf-8", errors="ignore")
    parser = _SanitizingHtmlParser()
    try:
        parser.feed(limited)
        parser.close()
    except Exception:  # noqa: BLE001
        pass
    return parser.get_html(), truncated


def _build_html2text():
    try:
        html2text = importlib.import_module("html2text")
    except ModuleNotFoundError:
        return _FallbackHtml2Text()

    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_images = True
    converter.ignore_emphasis = False
    converter.ignore_links = False
    converter.mark_code = True
    converter.protect_links = True
    converter.single_line_break = False
    converter.unicode_snob = True
    return converter


_TAG_BREAK_RE = re.compile(
    r"</?(?:article|aside|blockquote|br|div|h[1-6]|hr|li|p|section|tr|ul|ol)[^>]*>", re.IGNORECASE
)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")


class _FallbackHtml2Text:
    """Small built-in fallback when html2text is unavailable."""

    def handle(self, sanitized_html: str) -> str:
        with_breaks = _TAG_BREAK_RE.sub("\n", sanitized_html)
        stripped = _TAG_STRIP_RE.sub("", with_breaks)
        return unescape(stripped)


def _collapse_markdown(text: str) -> str:
    lines = [
        re.sub(r"[ \t]{2,}", " ", line.rstrip())
        for line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    ]
    collapsed: list[str] = []
    blank_run = 0
    for line in lines:
        if line:
            blank_run = 0
            collapsed.append(line)
            continue
        blank_run += 1
        if blank_run <= 2:
            collapsed.append("")
    return "\n".join(collapsed).strip()


def convert_html_to_markdown(
    html: str,
    *,
    max_bytes: int = HTML_SANITIZE_MAX_BYTES,
) -> tuple[str, bool]:
    """Sanitize HTML and convert it to markdown."""
    sanitized_html, truncated = sanitize_html_for_markdown(html, max_bytes=max_bytes)
    markdown = _build_html2text().handle(sanitized_html)
    return _collapse_markdown(markdown), truncated


def is_text_content_type(content_type: str) -> bool:
    """Return True if the content type is a text-like type we can process."""
    raw = str(content_type or "").strip().lower()
    mime = raw.split(";", 1)[0].strip()
    return mime in _TEXT_CONTENT_TYPES
