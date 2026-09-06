"""Contract tests for the out-of-band worker secret split + frame codec."""

from __future__ import annotations

import copy
import io
import json
import struct
from pathlib import Path

import pytest

from sidecar.runtime.worker_payload import write_worker_payload
from sidecar.runtime.worker_secrets import (
    BROKERED_SECRET_KEYS,
    MAX_SECRETS_FRAME_BYTES,
    MCP_AUTH_SECRETS_KEY,
    SECRET_CONFIG_KEYS,
    SecretFrameError,
    encode_secrets_frame,
    guard_no_secret_keys,
    merge_config_secrets,
    read_secrets_frame,
    secret_key_paths,
    split_config_secrets,
)

_HEADER = struct.Struct("!I")
_SENTINEL = "sentinel-bearer-token-value"

# The archived cloud secret keys sidecar/runtime/capabilities.py used to strip
# on its own; the new denylist must remain a SUPERSET of them.
_ARCHIVED_CLOUD_SECRET_KEYS = frozenset(
    {"anthropic_api_key", "openai_api_key", "gemini_api_key"}
)


def _all_three_secret_shapes() -> dict[str, object]:
    """A raw config carrying every secret shape the leak class covers."""
    return {
        "engine_type": "chatgpt",
        "model": "gpt-5.5",
        "chatgpt_access_token": _SENTINEL,
        "tools_web_search_provider_keys": {"brave": "brave-key", "tavily": "tavily-key"},
        "mcp_servers": [
            {
                "name": "alpha",
                "transport": "sse",
                "auth": {"kind": "bearer", "token": "alpha-bearer"},
            },
            {
                "name": "beta",
                "transport": "sse",
                "auth": {
                    "kind": "oauth_client_credentials",
                    "client_id": "beta-client",
                    "client_secret": "beta-client-secret",
                },
            },
        ],
    }


class _RecordingStream(io.BytesIO):
    """BytesIO that records every read size so body reads can be proven absent."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:  # type: ignore[override]
        self.read_sizes.append(int(size))
        return super().read(size)


# ── denylist shape ──────────────────────────────────────────────────


def test_secret_config_keys_is_superset_of_archived_cloud_secret_keys() -> None:
    assert _ARCHIVED_CLOUD_SECRET_KEYS <= SECRET_CONFIG_KEYS
    assert "chatgpt_access_token" in SECRET_CONFIG_KEYS
    assert "tools_web_search_provider_keys" in SECRET_CONFIG_KEYS
    assert "telemetry_dsn" in SECRET_CONFIG_KEYS


def test_brokered_keys_are_a_strict_subset_that_excludes_telemetry_dsn() -> None:
    # telemetry_dsn is read straight off params["secrets"] by
    # _apply_telemetry_config; it must never enter a config dict.
    assert BROKERED_SECRET_KEYS < SECRET_CONFIG_KEYS
    assert "telemetry_dsn" not in BROKERED_SECRET_KEYS
    assert BROKERED_SECRET_KEYS == {
        "chatgpt_access_token",
        "openai_compatible_api_key",
        "tools_web_search_provider_keys",
    }


def test_openai_compatible_api_key_is_secret_and_brokered() -> None:
    assert "openai_compatible_api_key" in SECRET_CONFIG_KEYS
    assert "openai_compatible_api_key" in BROKERED_SECRET_KEYS


# ── split / merge ───────────────────────────────────────────────────


def test_split_then_merge_is_identity_across_all_three_secret_shapes() -> None:
    original = _all_three_secret_shapes()

    scrubbed, secrets = split_config_secrets(original)

    assert merge_config_secrets(scrubbed, secrets) == original


def test_split_config_secrets_does_not_mutate_its_input() -> None:
    # The original defect was in-place mutation of params["config"], which is
    # exactly how the token reached BrainStack.raw_config. Direct regression pin.
    original = _all_three_secret_shapes()
    before = copy.deepcopy(original)

    scrubbed, secrets = split_config_secrets(original)

    assert original == before
    assert original["mcp_servers"][0]["auth"] == {"kind": "bearer", "token": "alpha-bearer"}
    assert scrubbed is not original
    assert scrubbed["mcp_servers"] is not original["mcp_servers"]
    assert secrets["chatgpt_access_token"] == _SENTINEL


def test_split_config_secrets_removes_every_secret_shape_from_the_config() -> None:
    scrubbed, secrets = split_config_secrets(_all_three_secret_shapes())

    assert "chatgpt_access_token" not in scrubbed
    assert "tools_web_search_provider_keys" not in scrubbed
    assert scrubbed["mcp_servers"][0]["auth"] == {"kind": "bearer"}
    assert scrubbed["mcp_servers"][1]["auth"] == {
        "kind": "oauth_client_credentials",
        "client_id": "beta-client",
    }
    assert _SENTINEL not in json.dumps(scrubbed)
    assert "beta-client-secret" not in json.dumps(scrubbed)
    assert secret_key_paths(scrubbed) == []
    rows = secrets[MCP_AUTH_SECRETS_KEY]
    assert [(row["server"], row["field"], row["value"]) for row in rows] == [
        ("alpha", "token", "alpha-bearer"),
        ("beta", "client_secret", "beta-client-secret"),
    ]


def test_split_config_secrets_ignores_non_dict_input() -> None:
    assert split_config_secrets(None) == ({}, {})
    assert split_config_secrets("not-a-config") == ({}, {})


def test_split_config_secrets_leaves_secret_free_mcp_servers_untouched() -> None:
    config = {"mcp_servers": [{"name": "alpha", "auth": {"kind": "bearer"}}, "junk"]}

    scrubbed, secrets = split_config_secrets(config)

    assert MCP_AUTH_SECRETS_KEY not in secrets
    assert scrubbed["mcp_servers"] is config["mcp_servers"]


@pytest.mark.parametrize("secrets", [None, {}])
def test_merge_with_absent_secrets_yields_a_secret_free_config(secrets: object) -> None:
    # ABSENT MEANS CLEAR: a scrubbed config plus no secrets must not resurrect
    # a previous generation's token.
    scrubbed, _lifted = split_config_secrets(_all_three_secret_shapes())

    merged = merge_config_secrets(scrubbed, secrets)

    assert "chatgpt_access_token" not in merged
    assert "tools_web_search_provider_keys" not in merged
    assert merged["mcp_servers"][1]["auth"] == {
        "kind": "oauth_client_credentials",
        "client_id": "beta-client",
    }
    assert secret_key_paths(merged) == []


def test_merge_config_secrets_returns_a_new_config_and_ignores_unknown_keys() -> None:
    scrubbed = {"engine_type": "chatgpt"}

    merged = merge_config_secrets(scrubbed, {"chatgpt_access_token": _SENTINEL, "junk": "x"})

    assert merged is not scrubbed
    assert scrubbed == {"engine_type": "chatgpt"}
    assert merged["chatgpt_access_token"] == _SENTINEL
    assert "junk" not in merged


def test_merge_resolves_mcp_rows_by_name_when_the_index_is_out_of_range() -> None:
    config = {"mcp_servers": [{"name": "alpha"}, {"name": "beta"}]}
    rows = [{"server": "beta", "index": 99, "field": "token", "value": "beta-token"}]

    merged = merge_config_secrets(config, {MCP_AUTH_SECRETS_KEY: rows})

    assert merged["mcp_servers"][1]["auth"] == {"token": "beta-token"}
    assert merged["mcp_servers"][0] == {"name": "alpha"}
    assert config["mcp_servers"][1] == {"name": "beta"}


def test_merge_drops_mcp_rows_naming_an_unknown_field_or_server() -> None:
    config = {"mcp_servers": [{"name": "alpha"}]}
    rows = [
        {"server": "alpha", "index": -1, "field": "password", "value": "x"},
        {"server": "nope", "index": -1, "field": "token", "value": "y"},
    ]

    merged = merge_config_secrets(config, {MCP_AUTH_SECRETS_KEY: rows})

    assert merged["mcp_servers"] == [{"name": "alpha"}]


# ── key-name tripwire ───────────────────────────────────────────────


def test_secret_key_paths_finds_nested_mcp_auth_client_secret() -> None:
    paths = secret_key_paths(_all_three_secret_shapes())

    assert "mcp_servers[1].auth.client_secret" in paths
    assert "mcp_servers[0].auth.token" in paths
    assert "chatgpt_access_token" in paths
    assert "tools_web_search_provider_keys" in paths


def test_secret_key_paths_only_flags_token_fields_under_an_auth_container() -> None:
    # "token" is a common word; flagging it everywhere would fail closed on
    # innocent payloads (the session-note payload counts tokens).
    assert secret_key_paths({"total_token_count": 12, "usage": {"token": 3}}) == []
    assert secret_key_paths({"auth": {"token": "x"}}) == ["auth.token"]


def test_secret_key_paths_fails_closed_at_max_depth() -> None:
    node: dict[str, object] = {"chatgpt_access_token": _SENTINEL}
    for _ in range(6):
        node = {"nest": node}

    assert secret_key_paths(node, max_depth=12) != []
    with pytest.raises(SecretFrameError, match="depth"):
        secret_key_paths(node, max_depth=2)


def _deep_secret_payload() -> dict[str, object]:
    node: dict[str, object] = {"openai_api_key": _SENTINEL}
    for _ in range(13):
        node = {"nest": node}
    return node


def test_guard_no_secret_keys_rejects_secret_beyond_depth_limit() -> None:
    with pytest.raises(SecretFrameError, match="depth"):
        guard_no_secret_keys(_deep_secret_payload(), context="background worker payload")


def test_write_worker_payload_rejects_secret_beyond_depth_limit(tmp_path: Path) -> None:
    with pytest.raises(SecretFrameError, match="depth"):
        write_worker_payload(tmp_path, _deep_secret_payload())

    assert list(tmp_path.iterdir()) == []


def test_guard_no_secret_keys_raises_on_a_nested_hit_and_passes_clean() -> None:
    payload = {"config": {"mcp_servers": [{"name": "a", "auth": {"token": _SENTINEL}}]}}

    with pytest.raises(SecretFrameError) as error:
        guard_no_secret_keys(payload, context="background worker payload")

    assert "config.mcp_servers[0].auth.token" in str(error.value)
    # The path is named; the VALUE never is.
    assert _SENTINEL not in str(error.value)
    guard_no_secret_keys({"config": {"engine_type": "chatgpt"}}, context="clean")


# ── frame codec ─────────────────────────────────────────────────────


def test_encode_secrets_frame_is_empty_when_there_is_nothing_to_send() -> None:
    assert encode_secrets_frame({}) == b""
    assert encode_secrets_frame(None) == b""
    assert encode_secrets_frame({"not_a_secret": "x"}) == b""


def test_frame_round_trips_every_secret_shape_over_a_stream() -> None:
    _scrubbed, secrets = split_config_secrets(_all_three_secret_shapes())

    frame = encode_secrets_frame(secrets)
    decoded = read_secrets_frame(io.BytesIO(frame))

    assert decoded["chatgpt_access_token"] == _SENTINEL
    assert decoded["tools_web_search_provider_keys"] == {
        "brave": "brave-key",
        "tavily": "tavily-key",
    }
    assert decoded[MCP_AUTH_SECRETS_KEY] == secrets[MCP_AUTH_SECRETS_KEY]


def test_frame_round_trip_restores_the_original_config() -> None:
    original = _all_three_secret_shapes()
    scrubbed, secrets = split_config_secrets(original)

    decoded = read_secrets_frame(io.BytesIO(encode_secrets_frame(secrets)))

    assert merge_config_secrets(scrubbed, decoded) == original


def test_encode_secrets_frame_rejects_an_oversize_payload_without_leaking_it() -> None:
    oversize = {"chatgpt_access_token": "z" * (MAX_SECRETS_FRAME_BYTES + 64)}

    with pytest.raises(SecretFrameError) as error:
        encode_secrets_frame(oversize)

    assert "byte limit" in str(error.value)
    assert "z" * 64 not in str(error.value)


def test_encode_secrets_frame_rejects_unencodable_values() -> None:
    with pytest.raises(SecretFrameError, match="JSON-encodable"):
        encode_secrets_frame({"chatgpt_access_token": object()})


def test_read_secrets_frame_returns_empty_for_missing_or_empty_streams() -> None:
    assert read_secrets_frame(None) == {}
    assert read_secrets_frame(io.BytesIO(b"")) == {}


def test_read_secrets_frame_returns_empty_for_a_truncated_header() -> None:
    assert read_secrets_frame(io.BytesIO(b"\x00\x00")) == {}


def test_read_secrets_frame_returns_empty_for_a_truncated_body(
    caplog: pytest.LogCaptureFixture,
) -> None:
    body = json.dumps({"version": 1, "config_secrets": {"chatgpt_access_token": _SENTINEL}})
    encoded = body.encode("utf-8")
    truncated = _HEADER.pack(len(encoded)) + encoded[:5]

    with caplog.at_level("WARNING"):
        assert read_secrets_frame(io.BytesIO(truncated)) == {}

    assert "sidecar.runtime.background_worker.secret_frame_truncated" in [
        getattr(record, "event", "") for record in caplog.records
    ]
    assert _SENTINEL not in caplog.text


def test_read_secrets_frame_rejects_an_oversize_header_without_reading_the_body() -> None:
    stream = _RecordingStream(_HEADER.pack(MAX_SECRETS_FRAME_BYTES + 1) + b"x" * 512)

    assert read_secrets_frame(stream) == {}
    assert stream.read_sizes == [_HEADER.size]
    assert stream.tell() == _HEADER.size


def test_read_secrets_frame_rejects_a_zero_length_body_header() -> None:
    assert read_secrets_frame(io.BytesIO(_HEADER.pack(0))) == {}


def test_read_secrets_frame_rejects_a_wrong_version_or_junk_body() -> None:
    wrong_version = json.dumps({"version": 99, "config_secrets": {"chatgpt_access_token": "x"}})
    encoded = wrong_version.encode("utf-8")
    assert read_secrets_frame(io.BytesIO(_HEADER.pack(len(encoded)) + encoded)) == {}

    junk = b"not json"
    assert read_secrets_frame(io.BytesIO(_HEADER.pack(len(junk)) + junk)) == {}


def test_read_secrets_frame_drops_non_secret_keys_from_a_hostile_frame() -> None:
    body = json.dumps(
        {
            "version": 1,
            "config_secrets": {"chatgpt_access_token": _SENTINEL, "engine_type": "evil"},
            "mcp_auth": ["junk", {"field": "password", "value": "x"}],
        }
    ).encode("utf-8")

    decoded = read_secrets_frame(io.BytesIO(_HEADER.pack(len(body)) + body))

    assert decoded == {"chatgpt_access_token": _SENTINEL}


def test_read_secrets_frame_never_blocks_on_an_interactive_stream() -> None:
    class _Tty(io.BytesIO):
        def isatty(self) -> bool:
            return True

        def read(self, size: int = -1) -> bytes:  # type: ignore[override]
            raise AssertionError("a tty must never be read as a secret channel")

    assert read_secrets_frame(_Tty(b"anything")) == {}


def test_read_secrets_frame_survives_a_stream_that_raises() -> None:
    class _Broken(io.BytesIO):
        def read(self, size: int = -1) -> bytes:  # type: ignore[override]
            raise OSError("pytest: reading from stdin while output is captured!")

    assert read_secrets_frame(_Broken(b"")) == {}
