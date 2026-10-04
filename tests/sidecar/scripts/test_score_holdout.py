import pytest

from scripts.eval.dogfood.score_holdout import tree_hash


@pytest.mark.parametrize("present", [False, True])
def test_determinism_requires_outputs(tmp_path, present):
    folder = tmp_path / "outputs"
    if present:
        folder.mkdir()
    with pytest.raises(ValueError, match="output"):
        tree_hash(folder)


def test_determinism_requires_each_account_artifact(tmp_path):
    account = tmp_path / "account"
    account.mkdir()
    (account / "matches.csv").write_text("bank_ids,ledger_ids")
    with pytest.raises(ValueError, match="exceptions.csv"):
        tree_hash(tmp_path)


def test_determinism_hashes_complete_outputs(tmp_path):
    account = tmp_path / "account"
    account.mkdir()
    for name in ["matches.csv", "exceptions.csv", "summary.json"]:
        (account / name).write_text("output")
    assert len(tree_hash(tmp_path)) == 3
