"""Compatibility pytest entrypoint for legacy test command paths.

This module re-exports the split sidecar server suites so
`pytest tests/sidecar/test_server.py` remains valid.
"""

from .server_core.test_approval_retry import *  # noqa: F401,F403
from .server_core.test_chat_streaming import *  # noqa: F401,F403
from .server_core.test_logging_init import *  # noqa: F401,F403
from .server_core.test_memory_dispatch import *  # noqa: F401,F403
from .server_core.test_message_dispatch import *  # noqa: F401,F403
from .server_core.test_protocol_io import *  # noqa: F401,F403
from .test_server_tools import *  # noqa: F401,F403
