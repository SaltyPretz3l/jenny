from scripts.checks import check_complexity_contract as checker


def test_unenforced_public_method_limit_does_not_claim_pass(capsys):
    assert checker.main() == 0
    output = capsys.readouterr().out
    assert "NOT ENFORCED" in output
    assert "PASS" not in output
