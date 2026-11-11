"""The Electron browser guard and the sidecar web policy must agree on every address."""

from __future__ import annotations

import ipaddress
import json
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.web_url_policy import _is_loopback_ip, address_allowed

_FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "browser-use-address-cases.json"
_CASES = json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _CASES, ids=[case["ip"] for case in _CASES])
def test_sidecar_policy_matches_the_shared_address_table(case: dict[str, str]) -> None:
    ip = ipaddress.ip_address(case["ip"])
    allowed = address_allowed(ip, allow_private=False, allow_loopback=True)
    assert allowed is (case["expected"] != "blocked")
    assert _is_loopback_ip(ip) is (case["expected"] == "loopback")
