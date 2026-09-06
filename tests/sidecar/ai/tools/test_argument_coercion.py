import pytest

from sidecar.ai.tools.argument_coercion import BoolArgumentError, extract_bool_argument, parse_bool


def test_parse_bool_accepts_common_string_tokens() -> None:
    assert parse_bool("yes") is True
    assert parse_bool("off") is False
    assert parse_bool("") is False


def test_extract_bool_argument_strict_requires_boolean_values() -> None:
    assert extract_bool_argument({"force": True}, "force", default=False) is True
    assert extract_bool_argument({}, "force", default=True) is True
    with pytest.raises(BoolArgumentError):
        extract_bool_argument({"force": "true"}, "force")
