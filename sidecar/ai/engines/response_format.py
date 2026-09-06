"""Response format types for structured output / JSON mode.

Defines the engine-layer representation of a response format request.
Engines use :attr:`ResponseFormat.is_json` to decide whether to
constrain output to valid JSON.  The optional ``json_schema`` field
is carried to engines and passed to Ollama's ``/api/chat`` ``format`` field
for server-side structured output when applicable.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional


@dataclass(frozen=True)
class ResponseFormat:
    """Engine-layer response format specification.

    Attributes:
        type: ``"text"`` (default) or ``"json_object"``.
        json_schema: Optional JSON Schema dict carried to engines and consumed by
            Ollama when no tool-call payload is present in the same request.
    """

    type: Literal["text", "json_object"] = "text"
    json_schema: Optional[Dict[str, Any]] = field(default=None, repr=False)

    @property
    def is_json(self) -> bool:
        """Return True when the engine should produce valid JSON."""
        return self.type == "json_object"
