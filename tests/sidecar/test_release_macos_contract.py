from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def load_script(relative):
    spec = importlib.util.spec_from_file_location(Path(relative).stem, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def workflow():
    return yaml.safe_load((ROOT / '.github/workflows/release.yml').read_text())


def test_public_workflow_is_build_only_for_dispatch_and_verifies_before_upload():
    data = workflow()
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert policy._validate_public_release_safety(data) == []
    build = data['jobs']['build']
    assert "github.event_name == 'workflow_dispatch'" in build['if']
    assert "github.event_name == 'push'" in data['jobs']['prepare']['if']
    mac = next(row for row in build['strategy']['matrix']['include'] if row['eb_flag'] == '--mac')
    assert mac['os'] == 'macos-15' and mac['experimental'] is True
    runs = '\n'.join(step.get('run', '') for step in build['steps'])
    assert '--require-hashes --only-binary=:all: -r requirements-lock.txt' in runs
    assert 'pip check' in runs
    assert "platform.machine() == 'arm64'" in runs
    assert '--publish always' not in runs


@pytest.mark.parametrize('mutation', [
    'unguarded', 'missing-verifier', 'ignored-verifier', 'early-publish',
    'missing-native-host', 'late-native-host', 'ignored-native-host',
])
def test_release_policy_rejects_publication_regressions(mutation):
    data = copy.deepcopy(workflow())
    steps = data['jobs']['build']['steps']
    upload = next(step for step in steps if 'release_assets.py upload' in step.get('run', ''))
    verifier = next(step for step in steps if 'verify_macos_release.py' in step.get('run', ''))
    if mutation == 'unguarded':
        upload.pop('if')
    elif mutation == 'missing-verifier':
        steps.remove(verifier)
    elif mutation == 'ignored-verifier':
        verifier['continue-on-error'] = True
    elif mutation.endswith('native-host'):
        host = next(step for step in steps if 'build:restricted-host:release' in step.get('run', ''))
        if mutation == 'missing-native-host':
            steps.remove(host)
        elif mutation == 'late-native-host':
            steps.append(steps.pop(steps.index(host)))
        else:
            host['continue-on-error'] = True
    else:
        steps.insert(0, steps.pop(steps.index(upload)))
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert policy._validate_public_release_safety(data)


@pytest.mark.parametrize('changed', [
    'Contents/Resources/sidecar/sidecar',
    'Contents/Resources/restricted-host/jenny-plugin-host',
    'Contents/Resources/native/plugin-full-host-supervisor',
])
def test_zip_verification_rejects_a_different_runtime(tmp_path, changed):
    verifier = load_script('scripts/packaging/verify_macos_release.py')
    app = tmp_path / 'Jenny.app'
    archive = tmp_path / 'Jenny-arm64.zip'
    files = verifier.VERIFIED_APP_FILES
    with zipfile.ZipFile(archive, 'w') as bundle:
        for relative in files:
            target = app / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'verified bytes')
            bundle.writestr('Jenny.app/' + relative, b'verified bytes')
    verifier.verify_zip(archive, app)
    (app / changed).write_bytes(b'different build')
    with pytest.raises(RuntimeError, match='differs from verified app'):
        verifier.verify_zip(archive, app)


@pytest.mark.parametrize('host', ['restricted-host', 'native'])
@pytest.mark.parametrize('mutation', ['missing', 'digest', 'target', 'dirty', 'ineligible'])
def test_native_host_verification_rejects_incomplete_or_stale_packages(tmp_path, monkeypatch, host, mutation):
    verifier = load_script('scripts/packaging/verify_macos_release.py')
    monkeypatch.setattr(verifier.smoke, '_current_git_commit', lambda: 'current')
    digest = verifier.smoke._sha256
    manifests = {}
    for directory, binary_name, manifest_name in (
        ('restricted-host', 'jenny-plugin-host', 'jenny-plugin-host.manifest.json'),
        ('native', 'plugin-full-host-supervisor', 'manifest.json'),
    ):
        folder = tmp_path / directory
        folder.mkdir()
        binary = folder / binary_name
        binary.write_bytes(b'native binary')
        data = {
            'target': 'aarch64-apple-darwin', 'source_state': 'clean', 'release_eligible': True,
            'binary_filename': binary_name, 'binary_sha256': digest(binary),
            'api_version': 1, 'commit': 'current', 'source_commit': 'current',
            'source_tree_digest': 'a' * 64, 'authenticated_private_pipe': True,
            'contract_lock_v6_sha256': digest(ROOT / 'config/plugins/contract-lock-v6.json'),
            'abi_sha256': digest(ROOT / 'config/plugins/capability-abi/v1/jenny-restricted-host.wit'),
            'protocol_sha256': digest(ROOT / 'config/plugins/contract-lock-v4.json'),
            'sbom_filename': 'jenny-plugin-host.sbom.json',
        }
        (folder / data['sbom_filename']).write_text('{}')
        manifest = folder / manifest_name
        manifest.write_text(json.dumps(data))
        manifests[directory] = (manifest, data, binary)
    assert len(verifier.verify_native_hosts(tmp_path, tmp_path / 'verification.log')) == 2
    manifest, data, binary = manifests[host]
    if mutation == 'missing':
        binary.unlink()
    elif mutation == 'digest':
        binary.write_bytes(b'another build')
    else:
        key, value = {'target': ('target', 'x86_64-apple-darwin'),
                      'dirty': ('source_state', 'dirty'),
                      'ineligible': ('release_eligible', False)}[mutation]
        data[key] = value
        manifest.write_text(json.dumps(data))
    with pytest.raises(RuntimeError):
        verifier.verify_native_hosts(tmp_path, tmp_path / 'verification.log')


def test_verification_fails_closed_on_foreign_host(monkeypatch):
    verifier = load_script('scripts/packaging/verify_macos_release.py')
    monkeypatch.setattr(verifier.sys, 'platform', 'win32')
    with pytest.raises(RuntimeError, match='native arm64'):
        verifier.verify_release()


def test_update_metadata_binds_hash_and_size_to_the_published_zip(tmp_path):
    verifier = load_script('scripts/packaging/verify_macos_release.py')
    payload = b'archive bytes'
    (tmp_path / 'Jenny-arm64.zip').write_bytes(payload)
    metadata = {'files': [{'url': 'Jenny-arm64.zip', 'size': len(payload),
                           'sha512': base64.b64encode(hashlib.sha512(payload).digest()).decode()}]}
    (tmp_path / 'latest-mac.yml').write_text(yaml.safe_dump(metadata))
    verifier.verify_update_metadata(tmp_path)
    metadata['files'][0].pop('size')
    (tmp_path / 'latest-mac.yml').write_text(yaml.safe_dump(metadata))
    verifier.verify_update_metadata(tmp_path)
    (tmp_path / 'Jenny-arm64.zip').write_bytes(b'another archive')
    with pytest.raises(RuntimeError, match='SHA512 mismatch'):
        verifier.verify_update_metadata(tmp_path)


def test_update_metadata_rejects_paths_outside_release_assets(tmp_path):
    verifier = load_script('scripts/packaging/verify_macos_release.py')
    (tmp_path / 'latest-mac.yml').write_text(yaml.safe_dump({'files': [{'url': '../secret'}]}))
    with pytest.raises(RuntimeError, match='unexpected file'):
        verifier.verify_update_metadata(tmp_path)


def test_runtime_lock_keeps_platform_dependencies_and_mac_wheel_hashes():
    lock = (ROOT / 'requirements-lock.txt').read_text()
    assert "macholib==1.16.4 ; sys_platform == 'darwin'" in lock
    assert "pefile==2024.8.26 ; sys_platform == 'win32'" in lock
    assert "pywin32-ctypes==0.2.3 ; sys_platform == 'win32'" in lock
    # The exact wheel rejected by the public macOS release is now permitted.
    assert '4bd4cd07944443f5a265608cc6aab442e4f74dff8088b0dfc8238647b8f6ae9a' in lock


@pytest.mark.parametrize('mutation', ['missing-smoke', 'ignored-smoke', 'unguarded-publish'])
def test_linux_prepackaged_publication_requires_smoke_and_public_push(mutation):
    data = copy.deepcopy(workflow())
    steps = data['jobs']['build-linux']['steps']
    smoke = next(step for step in steps if 'smoke_packaged_flow.py' in step.get('run', ''))
    if mutation == 'missing-smoke':
        steps.remove(smoke)
    elif mutation == 'ignored-smoke':
        smoke['continue-on-error'] = True
    else:
        publish = next(step for step in steps if 'release_assets.py upload' in step.get('run', ''))
        publish.pop('if')
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert policy._validate_public_release_safety(data)


@pytest.mark.parametrize('name', ['build', 'build-linux'])
def test_every_prepare_dependent_build_requires_manual_dispatch_guard(name):
    data = copy.deepcopy(workflow())
    data['jobs'][name].pop('if')
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert any('manual dispatch' in error for error in policy._validate_public_release_safety(data))


def test_linux_publication_policy_accepts_job_rename_and_equivalent_flags():
    data = copy.deepcopy(workflow())
    job = data['jobs'].pop('build-linux')
    data['jobs']['linux-packages'] = job
    for step in job['steps']:
        step['run'] = step.get('run', '').replace(
            '--existing-artifacts --composition release', '--composition=release --existing-artifacts'
        ).replace('--linux --prepackaged dist/linux-unpacked', '--prepackaged=dist/linux-unpacked --linux')
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert policy._validate_public_release_safety(data) == []


@pytest.mark.parametrize('mutation', ['conditional', 'late', 'equals-unguarded'])
def test_linux_publication_cannot_bypass_verification_or_push_guard(mutation):
    data = copy.deepcopy(workflow())
    steps = data['jobs']['build-linux']['steps']
    smoke = next(step for step in steps if 'smoke_packaged_flow.py' in step.get('run', ''))
    if mutation == 'conditional':
        smoke['if'] = "github.event_name == 'workflow_dispatch'"
    elif mutation == 'late':
        steps.append(steps.pop(steps.index(smoke)))
    else:
        publish = next(step for step in steps if 'release_assets.py upload' in step.get('run', ''))
        publish['run'] = publish['run'].replace('--platform linux', '--platform=linux')
        publish.pop('if')
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert policy._validate_public_release_safety(data)


@pytest.mark.parametrize('job_name,marker', [
    ('build', 'verify_macos_release.py'),
    ('build', 'build:restricted-host:release'),
    ('build-linux', 'smoke_packaged_flow.py'),
])
@pytest.mark.parametrize('mutation', ['renamed-missing', 'same-step-late'])
def test_upload_checks_survive_job_rename_and_same_step_reordering(job_name, marker, mutation):
    data = copy.deepcopy(workflow())
    job = data['jobs'].pop(job_name)
    data['jobs']['renamed-packages'] = job
    steps = job['steps']
    verification = next(step for step in steps if marker in step.get('run', ''))
    steps.remove(verification)
    if mutation == 'same-step-late':
        upload = next(step for step in steps if 'release_assets.py upload' in step.get('run', ''))
        upload['run'] += '\n' + verification['run']
    policy = load_script('scripts/checks/check_release_version_policy.py')
    assert policy._validate_public_release_safety(data)
