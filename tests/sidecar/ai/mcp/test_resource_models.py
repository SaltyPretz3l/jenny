"""MCP resource model tests."""

from __future__ import annotations

from sidecar.ai.mcp.models import (
    RESOURCE_TRUST_UNTRUSTED_MCP,
    MCPResourceDescriptor,
    MCPResourceReadResult,
    MCPResourceTemplate,
)


def test_resource_descriptor_defaults_to_untrusted() -> None:
    descriptor = MCPResourceDescriptor(
        server_name="docs_server",
        resource_id="mcp://docs_server/notes/architecture",
        uri="docs://architecture",
        name="Architecture",
    )
    assert descriptor.trust == RESOURCE_TRUST_UNTRUSTED_MCP
    assert descriptor.mime_type == ""
    assert descriptor.size_bytes is None
    assert descriptor.annotations == {}


def test_resource_template_defaults_to_untrusted() -> None:
    template = MCPResourceTemplate(
        server_name="docs_server",
        name="Page",
        uri_template="docs://{page_id}",
    )
    assert template.trust == RESOURCE_TRUST_UNTRUSTED_MCP


def test_resource_read_result_carries_artifact_ref_for_binary() -> None:
    result = MCPResourceReadResult(
        server_name="docs_server",
        resource_id="mcp://docs_server/binary",
        uri="docs://binary",
        mime_type="application/pdf",
        artifact_ref="artifact_file_session_abc_pdf_hash123",
        size_bytes=200_000,
    )
    assert result.text_excerpt is None
    assert result.artifact_ref == "artifact_file_session_abc_pdf_hash123"
    assert result.trust == RESOURCE_TRUST_UNTRUSTED_MCP


def test_resource_read_result_truncation_flag() -> None:
    result = MCPResourceReadResult(
        server_name="docs_server",
        resource_id="mcp://docs_server/long",
        uri="docs://long",
        mime_type="text/markdown",
        text_excerpt="# Title\n... (excerpt)",
        truncated=True,
        size_bytes=50_000,
    )
    assert result.truncated is True
    assert result.text_excerpt is not None
