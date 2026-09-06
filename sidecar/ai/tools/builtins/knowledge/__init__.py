"""Deterministic, vector-free knowledge tools over user-registered folders.

Three read-only tools behind ``tools_knowledge_enabled`` (default-off):
``knowledge_search`` (grep-worker reuse), ``knowledge_view`` (rich-file
adapter reuse), ``knowledge_exec`` (bounded ls/tree/find). No
index, no embeddings — respects the ``no_vector_db`` decision.
"""

from sidecar.ai.tools.builtins.knowledge.exec_ops import knowledge_exec_tool
from sidecar.ai.tools.builtins.knowledge.roots import configure_knowledge_tools
from sidecar.ai.tools.builtins.knowledge.search import knowledge_search_tool
from sidecar.ai.tools.builtins.knowledge.view import knowledge_view_tool

__all__ = [
    "configure_knowledge_tools",
    "knowledge_exec_tool",
    "knowledge_search_tool",
    "knowledge_view_tool",
]
