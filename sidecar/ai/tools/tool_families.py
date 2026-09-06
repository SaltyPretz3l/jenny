"""Shared tool-family metadata and boundary-aware text matching."""

import re

KNOWN_TOOL_FAMILIES: frozenset[str] = frozenset(
    {
        "artifact",
        "browser",
        "code_intelligence",
        "diagram",
        "discovery",
        "filesystem",
        "git",
        "home",
        "knowledge",
        "other",
        "python",
        "rich_files",
        "runtime",
        "shell",
        "todo",
        "web",
        "workspace",
    }
)

TOOL_FAMILY_NAMES: dict[str, tuple[str, ...]] = {
    "filesystem": (
        "read_file",
        "list_dir",
        "glob_files",
        "grep_search",
        "workspace_manifest_read",
    ),
    "git": (
        "git_status",
        "git_log",
        "git_diff",
        "git_show",
        "workspace_change_baseline",
        "workspace_change_delta",
        "worktree_list",
        "worktree_create",
        "worktree_select",
        "worktree_delete",
    ),
    "diagram": ("mermaid_generate",),
    "home": ("home",),
    "python": ("python_execute",),
    "todo": ("todo_read", "todo_write"),
    "web": ("web_search", "fetch_url"),
    "browser": (
        "browser_open",
        "browser_screenshot",
        "browser_close",
        "browser_click",
        "browser_type",
        "browser_eval",
    ),
    "code_intelligence": (
        "lsp",
        "lsp_diagnostics",
        "lsp_symbols",
        "lsp_definition",
        "lsp_references",
    ),
    "runtime": (
        "automation_list",
        "automation_read",
        "jenny_status",
        "delegate",
    ),
    "rich_files": (
        "pdf_inspect",
        "image_inspect",
        "spreadsheet_inspect",
        "document_inspect",
        "presentation_inspect",
        "notebook_inspect",
    ),
    "knowledge": (
        "knowledge_search",
        "knowledge_view",
        "knowledge_exec",
    ),
}

REQUESTED_TOOL_FAMILY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "filesystem": ("file", "files", "filesystem", "workspace", "manifest", "grep", "glob"),
    "git": ("git", "branch", "commit", "diff", "worktree", "worktrees"),
    "diagram": ("mermaid", "diagram", "flowchart"),
    "home": (
        "home",
        "home dashboard",
        "daybook",
        "calendar",
        "agenda",
        "reminder",
        "reminders",
        "scratchpad",
    ),
    "python": ("python", "python runtime", "python tool", "python execution"),
    "todo": ("todo", "to-do", "task list"),
    "web": ("web search", "internet", "browse", "live search"),
    "browser": (
        "browser",
        "browser_open",
        "browser_screenshot",
        "browser_close",
        "browser_click",
        "browser_type",
        "browser_eval",
        "browser tool",
        "browser tools",
        "browser bridge",
        "browser session",
        "headless browser",
    ),
    "code_intelligence": (
        "code intelligence",
        "lsp",
        "language server",
        "symbols",
        "definitions",
        "references",
        "diagnostics",
    ),
    "runtime": (
        "automation",
        "automations",
        "scheduled task",
        "scheduled tasks",
        "runtime status",
        "subagent",
        "sub-agent",
        "research agent",
    ),
    "rich_files": (
        "rich file",
        "rich files",
        "pdf",
        "image",
        "media file",
        "media files",
        "inspect pdf",
        "inspect image",
        "image dimensions",
        "spreadsheet",
        "spreadsheets",
        "workbook",
        "worksheet",
        "xlsx",
        "xlsm",
        "inspect spreadsheet",
        "document",
        "documents",
        "docx",
        "docm",
        "inspect document",
        "presentation",
        "presentations",
        "slide deck",
        "pptx",
        "pptm",
        "inspect presentation",
        "notebook",
        "notebooks",
        "ipynb",
        "inspect notebook",
    ),
    "knowledge": (
        "knowledge base",
        "knowledge folder",
        "knowledge folders",
        "registered docs",
        "registered documents",
        "document corpus",
    ),
}

TOOL_ALIASES: dict[str, tuple[str, ...]] = {
    "fetch_url": ("fetch url", "open url", "read webpage"),
    "glob_files": ("glob", "file search"),
    "home": ("home", "home dashboard", "calendar", "reminders", "scratchpad"),
    "grep_search": ("grep", "search files"),
    "lsp": (
        "code intelligence",
        "language server",
        "diagnostics",
        "language diagnostics",
        "symbols",
        "document symbols",
        "definition",
        "definitions",
        "go to definition",
        "references",
        "find references",
    ),
    "mermaid_generate": ("diagram", "mermaid", "mermaid syntax", "zoomable diagram"),
    "python_execute": ("python", "python runtime", "python sandbox", "execute python"),
    "read_file": ("read file", "file reader"),
    "web_search": ("web search", "live web search", "live web", "internet search"),
    "workspace_manifest_read": ("workspace manifest", "manifest", "project manifest"),
    "browser_open": ("browser open", "open browser", "browser session"),
    "browser_screenshot": ("browser screenshot", "screenshot browser"),
    "browser_close": ("browser close", "close browser"),
    "browser_click": ("browser click", "click browser", "click selector"),
    "browser_type": ("browser type", "type browser", "type into browser"),
    "browser_eval": ("browser eval", "evaluate browser", "page javascript"),
    "worktree_list": ("worktree list", "list worktrees", "git worktrees"),
    "worktree_create": ("worktree create", "create worktree", "new worktree"),
    "automation_list": ("automation list", "list automations", "scheduled tasks"),
    "automation_read": ("automation read", "read automation", "automation details"),
    "delegate": (
        "delegate",
        "subagent",
        "sub-agent",
        "research agent",
        "child research",
        "parallel research",
    ),
    "pdf_inspect": ("pdf inspect", "inspect pdf", "pdf", "pdf preview"),
    "image_inspect": ("image inspect", "inspect image", "image dimensions", "image preview"),
    "spreadsheet_inspect": (
        "spreadsheet inspect",
        "inspect spreadsheet",
        "workbook inspect",
        "xlsx inspect",
    ),
    "document_inspect": (
        "document inspect",
        "inspect document",
        "docx inspect",
        "word document inspect",
    ),
    "presentation_inspect": (
        "presentation inspect",
        "inspect presentation",
        "pptx inspect",
        "slide deck inspect",
    ),
    "notebook_inspect": (
        "notebook inspect",
        "inspect notebook",
        "ipynb inspect",
        "jupyter notebook inspect",
    ),
    "knowledge_search": ("knowledge search", "search knowledge base", "search registered docs"),
    "knowledge_view": ("knowledge view", "view knowledge document", "read knowledge document"),
    "knowledge_exec": ("knowledge exec", "list knowledge folders", "knowledge tree"),
}

TOOL_FAMILY_ALIASES: dict[str, tuple[str, ...]] = {
    "filesystem": ("filesystem", "workspace files", "source files"),
    "git": ("git", "git status", "git diff", "git log", "git worktree", "worktrees"),
    "diagram": ("diagram", "diagrams", "mermaid", "mermaid syntax", "flowchart"),
    "home": ("home", "home dashboard", "daybook", "calendar", "reminders", "scratchpad"),
    "python": ("python", "python runtime", "python sandbox", "execute python"),
    "todo": ("todo", "task list"),
    "web": ("web search", "live web search", "browse the web"),
    "browser": ("browser tools", "headless browser", "playwright", "browser session"),
    "code_intelligence": (
        "code intelligence",
        "lsp",
        "language server",
        "symbols",
        "definitions",
        "references",
        "diagnostics",
    ),
    "runtime": (
        "runtime",
        "automations",
        "automation tools",
        "scheduled tasks",
        "harness",
        "subagent",
        "sub-agent",
        "child research",
    ),
    "rich_files": (
        "rich files",
        "pdf",
        "spreadsheet",
        "document",
        "presentation",
        "notebook",
        "media files",
    ),
    "knowledge": (
        "knowledge",
        "knowledge base",
        "knowledge folders",
        "registered docs",
        "document corpus",
    ),
}

_SINGLE_WORD_RE = re.compile(r"^[a-z0-9]+$")
_SINGLE_WORD_ALIAS_PATTERNS: dict[str, re.Pattern[str]] = {
    alias: re.compile(rf"\b{re.escape(alias)}\b")
    for aliases in (
        *REQUESTED_TOOL_FAMILY_KEYWORDS.values(),
        *TOOL_ALIASES.values(),
        *TOOL_FAMILY_ALIASES.values(),
    )
    for raw_alias in aliases
    if (alias := str(raw_alias or "").strip().lower()) and _SINGLE_WORD_RE.fullmatch(alias)
}


def contains_tool_keyword(text: str, keyword: str) -> bool:
    normalized = str(keyword or "").strip().lower()
    if not normalized:
        return False
    return find_tool_alias_index(str(text or "").lower(), normalized) is not None


def find_tool_alias_index(text: str, alias: str) -> int | None:
    normalized_text = str(text or "")
    normalized_alias = str(alias or "").strip().lower()
    if not normalized_text or not normalized_alias:
        return None
    if _SINGLE_WORD_RE.fullmatch(normalized_alias):
        pattern = _SINGLE_WORD_ALIAS_PATTERNS.get(normalized_alias)
        if pattern is None:
            pattern = re.compile(rf"\b{re.escape(normalized_alias)}\b")
        match = pattern.search(normalized_text)
        return match.start() if match else None
    index = normalized_text.find(normalized_alias)
    return index if index >= 0 else None


def tool_family_for_status(*, name: str, tool_family: str | None) -> str | None:
    normalized_family = str(tool_family or "").strip().lower()
    if normalized_family in KNOWN_TOOL_FAMILIES:
        return normalized_family
    normalized_name = str(name or "").strip().lower()
    for family, tool_names in TOOL_FAMILY_NAMES.items():
        if normalized_name in tool_names:
            return family
    return None


def status_matches_tool_family(*, name: str, tool_family: str | None, family: str) -> bool:
    normalized_family = str(family or "").strip().lower()
    return tool_family_for_status(name=name, tool_family=tool_family) == normalized_family


def requested_tool_families(value: str) -> tuple[str, ...]:
    text = str(value or "").strip().lower()
    if not text:
        return ()
    return tuple(
        family
        for family, keywords in REQUESTED_TOOL_FAMILY_KEYWORDS.items()
        if any(contains_tool_keyword(text, keyword) for keyword in keywords)
    )


def aliases_for_tool(tool_name: str) -> tuple[str, ...]:
    normalized = str(tool_name or "").strip().lower()
    if not normalized:
        return ()
    aliases = {normalized, normalized.replace("_", " ")}
    aliases.update(TOOL_ALIASES.get(normalized, ()))
    aliases.discard("")
    return tuple(sorted(aliases, key=len, reverse=True))
