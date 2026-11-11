from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "windows_signing", ROOT / "scripts/packaging/windows_signing.py"
)
windows_signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windows_signing)

PUBLISHER = "Jane Q. Doe"


def full_env(**overrides: str) -> dict[str, str]:
    env = {
        "JENNY_AZURE_SIGNING_ENDPOINT": "https://eus.codesigning.azure.net/",
        "JENNY_AZURE_SIGNING_ACCOUNT": "jenny-signing",
        "JENNY_AZURE_SIGNING_PROFILE": "jenny-public",
        "JENNY_AZURE_SIGNING_PUBLISHER": PUBLISHER,
        "AZURE_TENANT_ID": "tenant",
        "AZURE_CLIENT_ID": "client",
        "AZURE_CLIENT_SECRET": "never-printed",
    }
    env.update(overrides)
    return env


def test_no_settings_means_unsigned_build():
    assert windows_signing.signing_settings({}) is None


def test_partial_settings_fail_and_name_only_the_missing_settings():
    env = full_env(AZURE_CLIENT_ID="", JENNY_AZURE_SIGNING_PROFILE="  ")
    with pytest.raises(windows_signing.SigningConfigError) as error:
        windows_signing.signing_settings(env)
    message = str(error.value)
    assert "AZURE_CLIENT_ID" in message and "JENNY_AZURE_SIGNING_PROFILE" in message
    assert "never-printed" not in message


@pytest.mark.parametrize(
    "overrides",
    [
        {"JENNY_AZURE_SIGNING_ENDPOINT": "http://eus.codesigning.azure.net/"},
        {"JENNY_AZURE_SIGNING_ENDPOINT": "https://evil.example.com/"},
        {"JENNY_AZURE_SIGNING_ACCOUNT": "has space"},
        {"JENNY_AZURE_SIGNING_PROFILE": "-leading"},
        {"JENNY_AZURE_SIGNING_PUBLISHER": "two\nlines"},
        {"JENNY_AZURE_SIGNING_PUBLISHER": "--config=evil"},
    ],
)
def test_malformed_settings_fail_closed(overrides):
    with pytest.raises(windows_signing.SigningConfigError):
        windows_signing.signing_settings(full_env(**overrides))


def test_full_settings_switch_electron_builder_to_azure_and_strict_updates():
    config = windows_signing.signed_config(windows_signing.signing_settings(full_env()))
    assert config == {
        "extends": "file:electron-builder.yml",
        "win": {
            "azureSignOptions": {
                "publisherName": PUBLISHER,
                "endpoint": "https://eus.codesigning.azure.net/",
                "codeSigningAccountName": "jenny-signing",
                "certificateProfileName": "jenny-public",
            },
            "verifyUpdateCodeSignature": True,
            "forceCodeSigning": True,
        },
    }
    assert "never-printed" not in json.dumps(config) and "tenant" not in json.dumps(config)


def test_config_command_writes_overlay_without_credentials(tmp_path, monkeypatch, capsys):
    for name, value in full_env().items():
        monkeypatch.setenv(name, value)
    out = tmp_path / "signed.json"
    assert windows_signing.main(["config", "--out", str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    assert json.loads(text)["win"]["azureSignOptions"]["publisherName"] == PUBLISHER
    assert "never-printed" not in text and "never-printed" not in capsys.readouterr().out


def test_config_command_removes_stale_overlay_when_unconfigured(tmp_path, monkeypatch):
    for name in windows_signing.SETTINGS:
        monkeypatch.delenv(name, raising=False)
    out = tmp_path / "signed.json"
    out.write_text("{}", encoding="utf-8")
    assert windows_signing.main(["config", "--out", str(out)]) == 0
    assert not out.exists()
    # No signed config means verify has nothing to check.
    assert windows_signing.main(["verify", "--config", str(out), "--dist", str(tmp_path)]) == 0


_LOAD_WITH_ELECTRON_BUILDER = """
const {getConfig, validateConfiguration} = require('app-builder-lib/out/util/config/config');
const {Lazy} = require('lazy-val');
const pkg = new Lazy(() => Promise.resolve(require('./package.json')));
(async () => {
  const base = await getConfig(process.cwd(), 'electron-builder.yml', null, pkg);
  const signed = await getConfig(process.cwd(), process.argv[1], null, pkg);
  await validateConfiguration(signed, new Lazy(async () => null));
  process.stdout.write('\\n' + JSON.stringify({base, signed}));
})().catch((error) => { console.error(error.message); process.exit(1); });
"""


@pytest.mark.skipif(
    shutil.which("node") is None or not (ROOT / "node_modules/app-builder-lib").is_dir(),
    reason="needs node and the installed electron-builder",
)
def test_overlay_loads_base_config_once_through_electron_builder(tmp_path):
    overlay = tmp_path / "signed.json"
    overlay.write_text(
        json.dumps(windows_signing.signed_config(windows_signing.signing_settings(full_env()))),
        encoding="utf-8",
    )
    completed = subprocess.run(
        ["node", "-e", _LOAD_WITH_ELECTRON_BUILDER, str(overlay)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    # electron-builder logs to stdout first; the JSON is the last line.
    loaded = json.loads(completed.stdout.rsplit("\n", 1)[-1])
    base, signed = loaded["base"], loaded["signed"]
    assert signed["win"]["azureSignOptions"]["publisherName"] == PUBLISHER
    assert signed["win"]["verifyUpdateCodeSignature"] is True
    assert signed["win"]["forceCodeSigning"] is True
    for config in (base, signed):
        config.pop("extends", None)
        config["win"].pop("azureSignOptions", None)
        config["win"].pop("forceCodeSigning", None)
        config["win"]["verifyUpdateCodeSignature"] = False
    # Same resource lists, same everything: the base config was not merged twice.
    assert signed == base


def fake_dist(root: Path) -> Path:
    dist = root / "dist"
    unpacked = dist / "win-unpacked"
    for rel in (
        "Jenny.exe",
        "resources/sidecar/sidecar.exe",
        "resources/python-embed/python.exe",
        "resources/app.asar.unpacked/node_modules/conpty/OpenConsole.exe",
    ):
        (unpacked / rel).parent.mkdir(parents=True, exist_ok=True)
        (unpacked / rel).write_bytes(b"MZ")
    (dist / "Jenny-Setup-x64.exe").write_bytes(b"MZ")
    return dist


def runner_for(statuses: dict[str, tuple[str, str]]):
    def run(command, env):
        assert command[0] == "powershell"
        paths = json.loads(env["JENNY_SIGNATURE_PATHS"])
        rows = []
        for path in paths:
            status, signer = statuses.get(Path(path).name, ("Valid", PUBLISHER))
            rows.append({"Path": path, "Status": status, "Signer": signer})
        return json.dumps(rows)

    return run


def test_verify_accepts_jenny_signed_files_and_vendor_signed_executables(tmp_path):
    runner = runner_for(
        {
            "python.exe": ("Valid", "Python Software Foundation"),
            "OpenConsole.exe": ("Valid", "Microsoft Corporation"),
        }
    )
    checked = windows_signing.verify(fake_dist(tmp_path), PUBLISHER, runner)
    assert {p.name for p in checked} == {
        "Jenny-Setup-x64.exe",
        "Jenny.exe",
        "sidecar.exe",
        "python.exe",
        "OpenConsole.exe",
    }


@pytest.mark.parametrize(
    "statuses, expected",
    [
        ({"sidecar.exe": ("NotSigned", "")}, "sidecar.exe: signature status NotSigned"),
        ({"Jenny.exe": ("Valid", "Someone Else")}, "signed by 'Someone Else'"),
        (
            {"python.exe": ("HashMismatch", "Python Software Foundation")},
            "python.exe: signature status HashMismatch",
        ),
    ],
)
def test_verify_rejects_unsigned_or_foreign_signed_files(tmp_path, statuses, expected):
    with pytest.raises(RuntimeError, match=expected):
        windows_signing.verify(fake_dist(tmp_path), PUBLISHER, runner_for(statuses))


def test_verify_fails_when_a_signature_row_is_missing(tmp_path):
    with pytest.raises(RuntimeError, match="Could not read a signature"):
        windows_signing.verify(fake_dist(tmp_path), PUBLISHER, lambda c, e: "[]")


def test_verify_requires_the_windows_build_output(tmp_path):
    with pytest.raises(FileNotFoundError):
        windows_signing.verify(tmp_path, PUBLISHER, runner_for({}))


def test_verify_command_takes_the_publisher_from_the_signed_config(tmp_path, monkeypatch):
    for name in windows_signing.SETTINGS:
        monkeypatch.delenv(name, raising=False)
    config = tmp_path / "signed.json"
    config.write_text(
        json.dumps(windows_signing.signed_config(windows_signing.signing_settings(full_env()))),
        encoding="utf-8",
    )
    assert windows_signing.publisher_from_config(config) == PUBLISHER
    seen = {}
    monkeypatch.setattr(
        windows_signing, "verify", lambda dist, publisher: seen.setdefault("p", publisher) and []
    )
    assert windows_signing.main(["verify", "--config", str(config), "--dist", str(tmp_path)]) == 0
    assert seen["p"] == PUBLISHER


@pytest.mark.skipif(shutil.which("powershell") is None, reason="needs Windows PowerShell")
def test_powershell_reads_status_and_signer_of_real_files(tmp_path):
    unsigned = tmp_path / "unsigned café.exe"
    unsigned.write_bytes(b"MZ not really a program")
    rows = windows_signing.read_signatures([unsigned])
    assert len(rows) == 1
    assert rows[0]["Path"] == str(unsigned)
    assert rows[0]["Status"] in {"NotSigned", "UnknownError"}
    assert rows[0]["Signer"] == ""


def test_release_workflow_wires_opt_in_signing_around_the_windows_build():
    steps = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))[
        "jobs"
    ]["build"]["steps"]
    names = [step.get("name") for step in steps]
    configure = names.index("Configure Windows signing")
    build = names.index("Build installer without publishing")
    verify = names.index("Verify Windows signatures")
    assert configure < build < verify
    for index in (configure, verify):
        assert steps[index]["if"] == "runner.os == 'Windows'"
        assert "signed-build-config.json" in steps[index]["run"]
    assert set(windows_signing.SETTINGS) <= set(steps[configure]["env"])
    # Verify reads the publisher from the signed config and needs no secret.
    assert "env" not in steps[verify]
    # The macOS leg never receives the Azure credentials.
    for name in windows_signing.CREDENTIALS:
        assert steps[build]["env"][name].startswith("${{ runner.os == 'Windows' && secrets.")


def test_builder_config_keeps_vendor_signatures():
    win = yaml.safe_load((ROOT / "electron-builder.yml").read_text(encoding="utf-8"))["win"]
    assert {name.lower() for name in win["signExts"]} == {
        f"!{name}" for name in windows_signing.THIRD_PARTY_SIGNED
    }
    assert "azureSignOptions" not in win
    assert win["verifyUpdateCodeSignature"] is False
