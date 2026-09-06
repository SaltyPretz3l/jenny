from __future__ import annotations

import inspect
from concurrent.futures import ThreadPoolExecutor

from sidecar.ai.context.cache_detection import (
    CACHE_TTL_5MIN_SECONDS,
    CacheBreakDetector,
    stable_hash,
)
from sidecar.ai.context.prompt_cache import CacheSection, StructuredSystemPrompt


def _tool(name: str, description: str = "tool") -> dict[str, object]:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object"},
        "side_effecting": False,
    }


def test_cache_break_check_accepts_only_tokens_used_by_detection() -> None:
    parameters = inspect.signature(
        CacheBreakDetector.check_response_for_cache_break
    ).parameters

    assert tuple(parameters) == ("self", "source_key", "cache_read_tokens")


def test_cache_break_detector_requires_history_before_detection() -> None:
    detector = CacheBreakDetector()

    detector.record_prompt_state("req_1", "system", [_tool("read_file")])
    result = detector.check_response_for_cache_break("req_1", cache_read_tokens=12_000)

    assert result.detected is False
    assert result.reason == "insufficient_history"
    assert result.changed_categories == ()


def test_cache_break_detector_detects_system_prompt_change() -> None:
    detector = CacheBreakDetector()

    detector.record_prompt_state("req_1", "system v1", [_tool("read_file")])
    detector.check_response_for_cache_break("req_1", cache_read_tokens=12_000)
    detector.record_prompt_state("req_1", "system v2", [_tool("read_file")])
    result = detector.check_response_for_cache_break("req_1", cache_read_tokens=9_000)

    assert result.detected is True
    assert result.reason == "cache_read_drop"
    assert result.changed_categories == ("system_prompt",)


def test_cache_break_detector_tracks_the_daily_current_date_boundary() -> None:
    detector = CacheBreakDetector()
    sections = (CacheSection(name="identity", content="You are Jenny."),)
    day_one = StructuredSystemPrompt(sections=sections, current_date="2026-07-18")
    same_day = StructuredSystemPrompt(sections=sections, current_date="2026-07-18")
    day_two = StructuredSystemPrompt(sections=sections, current_date="2026-07-19")

    detector.record_prompt_state("session", day_one, [])
    detector.check_response_for_cache_break("session", cache_read_tokens=12_000)
    detector.record_prompt_state("session", same_day, [])
    same_day_result = detector.check_response_for_cache_break(
        "session", cache_read_tokens=9_000
    )
    detector.record_prompt_state("session", day_two, [])
    next_day_result = detector.check_response_for_cache_break(
        "session", cache_read_tokens=6_000
    )

    assert same_day_result.detected is True
    assert same_day_result.changed_categories == ()
    assert next_day_result.detected is True
    assert next_day_result.changed_categories == ("system_prompt",)


def test_cache_break_detector_reports_changed_tool_names() -> None:
    detector = CacheBreakDetector()

    detector.record_prompt_state("req_1", "system", [_tool("mcp__git__commit", "Commit changes")])
    detector.check_response_for_cache_break("req_1", cache_read_tokens=15_000)
    detector.record_prompt_state(
        "req_1", "system", [_tool("mcp__git__commit", "Commit and push changes")]
    )
    result = detector.check_response_for_cache_break("req_1", cache_read_tokens=11_000)

    assert result.detected is True
    assert result.reason == "cache_read_drop"
    assert result.changed_categories == ("mcp__git__commit",)


def test_cache_break_detector_ignores_small_drop_even_when_prompt_changes() -> None:
    detector = CacheBreakDetector()

    detector.record_prompt_state("req_1", "system v1", [_tool("read_file")])
    detector.check_response_for_cache_break("req_1", cache_read_tokens=12_000)
    detector.record_prompt_state("req_1", "system v2", [_tool("read_file")])
    result = detector.check_response_for_cache_break("req_1", cache_read_tokens=11_500)

    assert result.detected is False
    assert result.reason == "within_threshold"
    assert result.changed_categories == ()


def test_cache_break_detector_evicts_old_entries_when_capacity_is_exceeded() -> None:
    detector = CacheBreakDetector(max_entries=2)

    detector.record_prompt_state("req_1", "system", [_tool("read_file")])
    detector.record_prompt_state("req_2", "system", [_tool("write_file")])
    detector.record_prompt_state("req_3", "system", [_tool("glob_files")])

    assert list(detector._states.keys()) == ["req_2", "req_3"]


def test_cache_break_detector_resets_baseline_after_legitimate_drop() -> None:
    detector = CacheBreakDetector()

    detector.record_prompt_state("sess_1", "system", [_tool("read_file")])
    detector.check_response_for_cache_break("sess_1", cache_read_tokens=12_000)
    detector.reset_baseline("sess_1", reason="compaction")
    detector.record_prompt_state("sess_1", "system changed", [_tool("read_file")])

    result = detector.check_response_for_cache_break("sess_1", cache_read_tokens=7_000)

    assert result.detected is False
    assert result.reason == "baseline_reset:compaction"


def test_stable_hash_returns_hex_digest() -> None:
    digest = stable_hash("foo")
    assert isinstance(digest, str)
    assert len(digest) == 64
    assert all(ch in "0123456789abcdef" for ch in digest)


def test_cache_break_detector_skips_ttl_window_expiry(monkeypatch) -> None:
    timestamps = iter([1_000.0, 1_000.0 + CACHE_TTL_5MIN_SECONDS + 1])
    monkeypatch.setattr("sidecar.ai.context.cache_detection.time", lambda: next(timestamps))

    detector = CacheBreakDetector()
    detector.record_prompt_state("sess_1", "system", [_tool("read_file")])
    detector.check_response_for_cache_break("sess_1", cache_read_tokens=12_000)
    detector.record_prompt_state("sess_1", "system", [_tool("read_file")])

    result = detector.check_response_for_cache_break("sess_1", cache_read_tokens=0)

    assert result.detected is False
    assert result.reason == "ttl_window_5m"


def test_cache_break_detector_isolates_concurrent_child_request_keys() -> None:
    detector = CacheBreakDetector(max_entries=10)

    def run_child(index: int) -> tuple[str, str]:
        key = f"child-{index}"
        detector.record_prompt_state(key, f"system-{index}", [_tool(f"tool-{index}")])
        first = detector.check_response_for_cache_break(key, 5_000)
        detector.record_prompt_state(key, f"system-{index}", [_tool(f"tool-{index}")])
        second = detector.check_response_for_cache_break(key, 5_000)
        return first.reason, second.reason

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(run_child, range(8)))

    assert results == [("insufficient_history", "within_threshold")] * 8
