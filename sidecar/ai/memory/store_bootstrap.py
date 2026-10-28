"""Preflight and schema bootstrap seam for the durable memory store."""

from sidecar.ai.memory.store_migrations import (
    SCHEMA_VERSION,
    configure_connection,
    run_migrations,
)
from sidecar.ai.memory.store_preflight import (
    decode_text_replacing_damage,
    validate_memory_store_files,
    verify_memory_database_pages,
)

__all__ = [
    "SCHEMA_VERSION",
    "configure_connection",
    "decode_text_replacing_damage",
    "run_migrations",
    "validate_memory_store_files",
    "verify_memory_database_pages",
]
