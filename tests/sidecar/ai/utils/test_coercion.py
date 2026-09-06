from sidecar.ai.utils.coercion import (
    coerce_non_negative_int,
    coerce_optional_int,
    coerce_positive_finite_float,
)


def test_coerce_optional_int_rejects_bool_and_non_decimal_values() -> None:
    assert coerce_optional_int(True) is None
    assert coerce_optional_int("-7") is None


def test_coerce_optional_int_returns_integer_value() -> None:
    assert coerce_optional_int(7) == 7
    assert coerce_optional_int("42") == 42


def test_coerce_optional_int_rejects_other_types() -> None:
    assert coerce_optional_int(None) is None
    assert coerce_optional_int(3.9) is None


def test_coerce_non_negative_int_handles_invalid_and_negative_values() -> None:
    assert coerce_non_negative_int(None) == 0
    assert coerce_non_negative_int("bad") == 0
    assert coerce_non_negative_int(-5) == 0


def test_coerce_non_negative_int_returns_integer_value() -> None:
    assert coerce_non_negative_int("7") == 7
    assert coerce_non_negative_int(3.9) == 3


def test_coerce_positive_finite_float_rejects_invalid_values() -> None:
    assert coerce_positive_finite_float(None) == 0
    assert coerce_positive_finite_float(True) == 0
    assert coerce_positive_finite_float("bad") == 0
    assert coerce_positive_finite_float(-5) == 0
    assert coerce_positive_finite_float(float("inf")) == 0


def test_coerce_positive_finite_float_returns_numeric_value() -> None:
    assert coerce_positive_finite_float("7.5") == 7.5
    assert coerce_positive_finite_float(3) == 3.0
