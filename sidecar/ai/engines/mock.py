# ruff: noqa: C901, PLC0415, PLR0911, PLR0912, PLR0913, PLR2004
import json
import logging
import shlex
import time
from typing import TYPE_CHECKING, Any, Dict, Generator, List, Optional, Set, cast

from sidecar.runtime.local_engine.messages import contains_primary_system_message

from .base import BaseEngine, EngineMessage, ModelModality

if TYPE_CHECKING:
    from ..tools.models import GenerationResult
    from .response_format import ResponseFormat
    from .vision_input import VisionInput

logger = logging.getLogger(__name__)


class MockEngine(BaseEngine):
    """
    A fake brain that returns precanned responses.
    Useful for UI development without loading a heavy LLM.

    Supports all modalities so the UI can be tested end-to-end
    without a real model.
    """

    def __init__(
        self,
        enable_vision: bool = True,
        tool_call_responses: Optional[List["GenerationResult"]] = None,
    ):
        self._enable_vision = enable_vision
        self.model_name: str | None = None
        self._is_ready = False
        self._tool_call_responses = list(tool_call_responses or [])
        self._tool_call_index = 0

    @property
    def supported_modalities(self) -> Set[ModelModality]:
        mods: Set[ModelModality] = {ModelModality.TEXT}
        if self._enable_vision:
            mods.add(ModelModality.VISION)
        return mods

    @property
    def supports_tool_calling(self) -> bool:
        return True

    def set_provider_capability_profile_store(self, store: Any | None) -> None:
        self._provider_capability_profile_store = store

    def load_model(self, model_path: str) -> None:
        logger.info(f"MockEngine: 'Loading' model from {model_path}...")
        self.model_name = model_path
        self._is_ready = True
        logger.info("MockEngine: Ready.")
        self._record_capability_probe_success(model_path)

    def _record_capability_probe_success(self, model_name: str) -> None:
        store = getattr(self, "_provider_capability_profile_store", None)
        if store is None:
            return
        try:
            from sidecar.runtime.provider_capability_profile import (
                PROBE_STATUS_READY,
                ProviderCapabilityFeatures,
                ProviderCapabilityObserved,
                derive_endpoint_id,
                derive_model_id,
            )

            store.record_probe_result(
                endpoint_id=derive_endpoint_id("mock", None),
                model_id=derive_model_id(model_name) or "mock",
                features=ProviderCapabilityFeatures(chat_supported=True),
                observed=ProviderCapabilityObserved(),
                probe_status=PROBE_STATUS_READY,
            )
        except Exception:  # noqa: BLE001
            pass

    def generate(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
    ) -> str:
        _ = max_tokens
        _ = temperature
        _ = reasoning_effort
        _ = prompt_cache_enabled
        effective_messages = self._messages_with_system(messages, system)
        if effective_messages:
            last = effective_messages[-1].get("content", prompt)
            history_hint = ""
            non_system_count = sum(
                1
                for message in effective_messages
                if str(message.get("role", "")).lower() != "system"
            )
            prior_count = max(0, non_system_count - 1)
            if prior_count > 0:
                history_hint = f" Conversation context included {prior_count} prior message(s)."
            profile = self._personality_from_messages(effective_messages)
        else:
            last = prompt
            history_hint = ""
            profile = "balanced"

        text = self._compose_profiled_response(
            profile=profile, message_text=last, history_hint=history_hint
        )

        if response_format and response_format.is_json:
            return json.dumps({"response": text})

        return text

    @staticmethod
    def _personality_from_messages(messages: List[EngineMessage]) -> str:
        for message in messages:
            role = str(message.get("role", "")).strip().lower()
            if role != "system":
                continue
            content = str(message.get("content", "")).lower()
            if "personality profile: concise" in content:
                return "concise"
            if "personality profile: creative" in content:
                return "creative"
            if "personality profile: mentor" in content:
                return "mentor"
            if "active profile: concise" in content:
                return "concise"
            if "active profile: creative" in content:
                return "creative"
            if "active profile: mentor" in content:
                return "mentor"
        return "balanced"

    @staticmethod
    def _compose_profiled_response(profile: str, message_text: str, history_hint: str) -> str:
        if profile == "concise":
            return f"Mock concise response: '{message_text}'.{history_hint}".strip()
        if profile == "creative":
            return (
                "Mock creative response: "
                f"'{message_text}'. Idea spark: remix this into a small experiment.{history_hint}"
            )
        if profile == "mentor":
            return (
                "Mock mentor response: "
                "Step 1: define the immediate goal. "
                f"Step 2: take one concrete action for '{message_text}'. "
                "Step 3: review outcomes and adjust."
                f"{history_hint}"
            )
        return (
            "Mock sidecar response: "
            f"I received your message '{message_text}'."
            " Streaming is active."
            f"{history_hint}"
        )

    def generate_with_tools(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
    ) -> "GenerationResult":
        _ = tools
        from ..tools.models import GenerationResult

        effective_messages = self._messages_with_system(messages, system)

        if effective_messages:
            last_role = str(effective_messages[-1].get("role", "")).lower()
            if last_role == "tool":
                tool_content = str(effective_messages[-1].get("content", "")).strip()
                return GenerationResult(
                    content=f"Tool execution completed.\n{tool_content}".strip(),
                    finish_reason="stop",
                )
            latest_user = ""
            for message in reversed(effective_messages):
                if str(message.get("role", "")).lower() == "user":
                    latest_user = str(message.get("content", "")).strip()
                    break
            tool_result = self._mock_tool_call_result(latest_user)
            if tool_result is not None:
                return tool_result

        if self._tool_call_index < len(self._tool_call_responses):
            result = self._tool_call_responses[self._tool_call_index]
            self._tool_call_index += 1
            return result

        content = self.generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=effective_messages,
            response_format=response_format,
        )
        return GenerationResult(content=content, finish_reason="stop")

    @staticmethod
    def _messages_with_system(
        messages: Optional[List[EngineMessage]],
        system: str,
    ) -> List[EngineMessage]:
        normalized: List[EngineMessage] = []
        primary_system_text = str(system or "").strip()
        for message in messages or []:
            role = str(message.get("role", "") or "").strip().lower()
            content = str(message.get("content", "") or "").strip()
            if not role or not content:
                continue
            normalized.append({"role": role, "content": content})
        # Mirrors the Ollama/vLLM builders via the same shared helper: only an
        # exact duplicate of the primary prompt suppresses the prepend — other
        # system rows (overlays, a compaction summary) must not knock the
        # primary out of the request.
        if primary_system_text and not contains_primary_system_message(
            cast(List[Dict[str, Any]], normalized), primary_system_text
        ):
            normalized.insert(0, {"role": "system", "content": primary_system_text})
        return normalized

    def _mock_tool_call_result(self, latest_user: str) -> "GenerationResult | None":
        from ..tools.models import GenerationResult

        if not latest_user.lower().startswith("/tool "):
            return None

        payload = latest_user[6:].strip()
        if not payload:
            return GenerationResult(
                content="Tool command was empty.",
                finish_reason="stop",
            )

        tokens = self._safe_split(payload)
        if not tokens:
            return GenerationResult(
                content="Tool command could not be parsed.",
                finish_reason="stop",
            )

        command = tokens[0].lower()
        if command == "read" and len(tokens) == 2:
            return self._tool_result(
                "read_file",
                {"path": tokens[1]},
            )
        if command == "list" and len(tokens) <= 2:
            target = tokens[1] if len(tokens) == 2 else "."
            return self._tool_result(
                "list_dir",
                {"path": target},
            )
        if command == "write":
            target_and_content = payload[5:].strip()
            target, delimiter, content = target_and_content.partition(":::")
            if delimiter == ":::" and target.strip() and content.strip():
                return self._tool_result(
                    "write_file",
                    {
                        "path": self._strip_wrapping_quotes(target.strip()),
                        "content": content.strip(),
                    },
                )
        if command == "edit":
            edit_payload = payload[4:].strip()
            file_part, first_delimiter, remainder = edit_payload.partition(":::")
            old_part, second_delimiter, new_part = remainder.partition(":::")
            if first_delimiter == ":::" and second_delimiter == ":::" and file_part.strip():
                replace_all = False
                new_string = new_part
                if ":::all" in new_part:
                    new_string, _, _ = new_part.partition(":::all")
                    replace_all = True
                return self._tool_result(
                    "edit_file",
                    {
                        "file_path": self._strip_wrapping_quotes(file_part.strip()),
                        "old_string": old_part.strip(),
                        "new_string": new_string.strip(),
                        "replace_all": replace_all,
                    },
                )
        if command == "shell" and len(tokens) >= 2:
            command_text = payload[6:].strip()
            return self._tool_result(
                "run_command",
                {"command": command_text},
            )
        if command == "git" and len(tokens) >= 2:
            subcommand = tokens[1].lower()
            if subcommand == "status":
                arguments: Dict[str, Any] = {}
                if len(tokens) == 3:
                    arguments["cwd"] = tokens[2]
                return self._tool_result("git_status", arguments)
            if subcommand == "log":
                arguments = {}
                if len(tokens) >= 3:
                    if tokens[2].isdigit():
                        arguments["max_count"] = int(tokens[2])
                        if len(tokens) == 4:
                            arguments["cwd"] = tokens[3]
                    else:
                        arguments["cwd"] = tokens[2]
                return self._tool_result("git_log", arguments)
            if subcommand == "diff":
                arguments = {}
                remaining = tokens[2:]
                if remaining and remaining[0].lower() in {"staged", "--staged", "--cached"}:
                    arguments["staged"] = True
                    remaining = remaining[1:]
                if remaining:
                    first = remaining[0]
                    if first.lower().startswith("ref="):
                        arguments["ref"] = first.split("=", 1)[1]
                    elif first.lower().startswith("path="):
                        arguments["path"] = first.split("=", 1)[1]
                    elif first.lower().startswith("cwd="):
                        arguments["cwd"] = first.split("=", 1)[1]
                    elif len(remaining) == 1:
                        arguments["cwd"] = first
                for token in remaining[1:]:
                    lower_token = token.lower()
                    if lower_token.startswith("ref="):
                        arguments["ref"] = token.split("=", 1)[1]
                    elif lower_token.startswith("path="):
                        arguments["path"] = token.split("=", 1)[1]
                    elif lower_token.startswith("cwd="):
                        arguments["cwd"] = token.split("=", 1)[1]
                return self._tool_result("git_diff", arguments)
            if subcommand == "show":
                arguments = {}
                if len(tokens) >= 3:
                    arguments["ref"] = tokens[2]
                if len(tokens) == 4:
                    arguments["cwd"] = tokens[3]
                return self._tool_result("git_show", arguments)
        return GenerationResult(
            content="Tool command syntax is not recognized by mock engine.",
            finish_reason="stop",
        )

    @staticmethod
    def _tool_result(tool_id: str, arguments: Dict[str, Any]) -> "GenerationResult":
        from ..tools.models import GenerationResult, ToolCallRequest, ensure_tool_call_id

        return GenerationResult(
            content=f"Invoking tool '{tool_id}'.",
            tool_calls=(
                ToolCallRequest(
                    tool_id=tool_id,
                    arguments=arguments,
                    call_id=ensure_tool_call_id(
                        "",
                        provider="mock",
                        tool_name=tool_id,
                        # Use a fixed token so replay-fixture call IDs remain
                        # deterministic; this static method has no request context.
                        request_id="mock",
                        position=0,
                    ),
                ),
            ),
            finish_reason="tool_calls",
        )

    @staticmethod
    def _safe_split(value: str) -> list[str]:
        try:
            tokens = shlex.split(value, posix=False)
        except ValueError:
            return []
        return [MockEngine._strip_wrapping_quotes(token) for token in tokens if token.strip()]

    @staticmethod
    def _strip_wrapping_quotes(token: str) -> str:
        candidate = token.strip()
        if len(candidate) >= 2 and (
            (candidate.startswith('"') and candidate.endswith('"'))
            or (candidate.startswith("'") and candidate.endswith("'"))
        ):
            return candidate[1:-1]
        return candidate

    def stream(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
        cancel_handle: object | None = None,
    ) -> Generator[str, None, None]:
        _ = cancel_handle
        response = self.generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )

        if response_format and response_format.is_json:
            yield response
            return

        for word in response.split():
            yield word + " "
            time.sleep(0.1)

    def generate_with_vision(
        self,
        prompt: str,
        images: List["VisionInput"],
        max_tokens: int = 256,
        temperature: float = 0.7,
    ) -> "GenerationResult":
        from ..tools.models import GenerationResult

        return GenerationResult(
            content=f"[Mock Vision] I received {len(images)} image(s). You asked: '{prompt}'",
            finish_reason="stop",
        )

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = None
        self._is_ready = False
