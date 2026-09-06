"""Preflight and schema bootstrap seam for the durable memory store."""

from sidecar.ai.memory.store_migrations import (
    SCHEMA_VERSION,
    configure_connection,
    run_migrations,
)
from sidecar.ai.memory.store_preflight import validate_memory_store_files

__all__ = [
    "SCHEMA_VERSION",
    "configure_connection",
    "run_migrations",
    "validate_memory_store_files",
]
