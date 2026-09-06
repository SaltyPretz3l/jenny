"""Shared local-engine runtime contract helpers."""

from .contracts import (  # noqa: F401
    LOCAL_RUNTIME_CONTRACT_VERSION,
    build_capability_entry,
    build_engine_fallback_payload,
    build_readiness_payload,
    build_reasoning_entry,
    normalize_local_runtime_source,
)
from .messages import (  # noqa: F401
    demote_non_leading_system_messages,
    merge_consecutive_system_messages,
)
from .request_context import (  # noqa: F401
    bind_chat_request_context,
    build_app_profile_behavior,
    clear_chat_request_context,
    clear_request_context,
    current_app_profile_behavior,
    current_diagnostics_store,
    current_request_context,
    debug_option_enabled,
    effective_temperature,
    effective_top_k,
    install_request_context,
    request_id,
    scoped_chat_request_context,
)
from .snapshot import (  # noqa: F401
    active_app_profile_payload,
    active_model_capabilities_payload,
    active_template_diagnostics_payload,
    build_local_runtime_payload,
    context_metadata_payload,
    derive_legacy_runtime_aliases,
)
