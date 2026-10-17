"""Execute the real entrypoints with inert network and installation commands."""
from __future__ import annotations

import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SHELL_FIXTURE = r'''
import hashlib, json, os, pathlib, shutil, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
mode = os.environ.get('FIXTURE_MODE', '')
platform = os.environ.get('FIXTURE_PLATFORM', 'Linux')
with (root / 'calls').open('a') as out:
    out.write(json.dumps([name, *args]) + '\n')
payload = b'#!/bin/sh\nexit 1\n' if mode == 'launch' else b'#!/bin/sh\nexit 0\n'
if name == 'uname':
    print({'-s': platform, '-m': 'bad' if mode == 'arch' else ('arm64' if platform == 'Darwin' else 'x86_64'), '-r': '6.8.0'}[args[0]])
elif name == 'id': print('1000')
elif name == 'pgrep': sys.exit(0 if mode == 'running' else 1)
elif name == 'getconf': print('glibc 2.34' if mode == 'glibc' else 'glibc 2.35')
elif name == 'awk':
    if args[-1] == '/etc/os-release':
        print('debian' if os.environ.get('FIXTURE_DEB') else 'fedora')
    else:
        sys.exit(subprocess.call([os.environ['REAL_AWK'], *args]))
elif name in ('sha256sum', 'shasum'):
    print(hashlib.sha256(pathlib.Path(args[-1]).read_bytes()).hexdigest() + '  ' + args[-1])
elif name == 'curl':
    if mode == 'network': sys.exit(22)
    if '-w' in args:
        print('https://github.com/SaltyPretz3l/jenny/releases/tag/' + ('v1.5.0-beta' if mode == 'tag' else 'v1.5.0'), end='')
    else:
        dest = pathlib.Path(args[args.index('-o') + 1])
        if 'SHA256SUMS' in args[-1]:
            asset = 'Jenny-arm64.dmg' if platform == 'Darwin' else ('Jenny-amd64.deb' if os.environ.get('FIXTURE_DEB') and (root / 'bin/sudo').exists() else 'Jenny-x86_64.AppImage')
            digest = '0' * 64 if mode == 'hash' else hashlib.sha256(payload).hexdigest()
            if mode == 'malformed': digest = 'not-a-hash'
            line = digest + '  ' + asset + '\n'
            dest.write_text('' if mode == 'missing' else line * (2 if mode == 'duplicate' else 1))
        else:
            if mode == 'asset': sys.exit(22)
            dest.write_bytes(payload)
            if mode == 'interrupted': sys.exit(18)
elif name == 'sudo':
    if mode == 'install': sys.exit(5)
    # Like the deb's install prefix, publish a packaged executable that records its launch.
    app = root / 'opt/Jenny/jenny'
    app.parent.mkdir(parents=True, exist_ok=True)
    app.write_text('#!/bin/sh\necho deb >> "$FIXTURE_ROOT/launched"\n')
    app.chmod(0o755)
elif name == 'mv':
    if mode in ('launcher', 'desktop') and args[0].endswith('/' + mode): sys.exit(5)
    if mode in ('replace', 'restore') and args[0].endswith('/new'): sys.exit(5)
    if mode == 'restore' and args[0].endswith('/previous'): sys.exit(5)
    sys.exit(subprocess.call([os.environ['REAL_MV'], *args]))
elif name == 'rm':
    if mode == 'cleanup' and '.stage.' in args[-1]: sys.exit(5)
    sys.exit(subprocess.call([os.environ['REAL_RM'], *args]))
elif name == 'hdiutil' and args[0] == 'attach':
    if mode == 'attach': sys.exit(5)
    app = pathlib.Path(args[args.index('-mountpoint') + 1]) / 'Jenny.app'
    app.mkdir()
    (app / 'new-version').write_text('new')
elif name == 'hdiutil' and args[0] == 'detach' and mode == 'detach': sys.exit(5)
elif name == 'ditto': shutil.copytree(args[0], args[1])
elif name == 'open' and mode == 'open': sys.exit(1)
elif name in ('jenny', 'apt-get', 'hdiutil', 'xattr', 'open', 'launchctl'): pass
else: raise RuntimeError((name, args))
'''


@pytest.fixture
def posix_install(tmp_path: Path):
    if os.name == 'nt':
        pytest.skip('POSIX subprocess cases require a POSIX shell (also run in WSL).')
    home = tmp_path / "user's home % with spaces"
    home.mkdir()
    temp = tmp_path / 'temp'
    temp.mkdir()
    binaries = tmp_path / 'bin'
    binaries.mkdir()
    for name in ('curl', 'uname', 'id', 'pgrep', 'getconf', 'awk', 'sudo', 'apt-get',
                 'jenny', 'mv', 'rm', 'sha256sum', 'shasum', 'hdiutil', 'ditto', 'xattr', 'open', 'launchctl'):
        target = binaries / name
        target.write_text('#!' + sys.executable + '\n' + SHELL_FIXTURE, encoding='utf-8')
        target.chmod(0o755)
    # Explicit utility set makes the simulated Linux cases independent of macOS PATH.
    for name in ('dirname', 'tr', 'mktemp', 'mkdir', 'rmdir', 'cp', 'chmod', 'grep',
                 'sed', 'sleep', 'date'):
        native = shutil.which(name)
        assert native, name
        (binaries / name).symlink_to(native)
    env = dict(os.environ, HOME=str(home), TMPDIR=str(temp), DISPLAY=':fixture',
               SSH_CONNECTION='', FIXTURE_ROOT=str(tmp_path),
               REAL_AWK=shutil.which('awk') or '', REAL_MV=shutil.which('mv') or '',
               REAL_RM=shutil.which('rm') or '', PATH=str(binaries))
    env.pop('XDG_DATA_HOME', None)  # Never publish into the host session's data directory.
    script = (ROOT / 'install.sh').read_text(encoding='utf-8')
    # Relocate the deb's packaged executable so no fixture can launch a real installation.
    packaged = 'packaged=/opt/Jenny/jenny\n'
    assert script.count('/opt/Jenny') == script.count(packaged)
    script = script.replace(packaged, f'packaged={shlex.quote(str(tmp_path / "opt/Jenny/jenny"))}\n')

    def run(mode='', platform='Linux', deb=False, without_sudo=False, extra_env=None):
        if without_sudo:
            (binaries / 'sudo').unlink(missing_ok=True)
        if platform == 'Darwin':
            if Path('/Applications/Jenny.app').exists():
                pytest.skip('Never test against a machine with a system Jenny installation.')
            # Always choose this owned app rather than touching /Applications.
            personal = home / 'Applications/Jenny.app'
            personal.mkdir(parents=True, exist_ok=True)
            (personal / 'old-version').write_text('old', encoding='utf-8')
        env.update(FIXTURE_MODE=mode, FIXTURE_PLATFORM=platform, FIXTURE_DEB='1' if deb else '',
                   DISPLAY='' if mode == 'headless' else ':fixture', WAYLAND_DISPLAY='')
        calls = tmp_path / 'calls'
        calls.unlink(missing_ok=True)
        result = subprocess.run(
            ['/bin/sh'], input=script,
            text=True, capture_output=True, env={**env, **(extra_env or {})}, timeout=30, check=False,
        )
        entries = [json.loads(line) for line in calls.read_text().splitlines()]
        if mode != 'detach':
            assert not list(temp.iterdir()), result.stderr
        assert not (home / '.local/share/jenny/.install-lock').exists()
        return result, entries, home

    return run


@pytest.mark.parametrize('platform,deb', [('Linux', False), ('Linux', True), ('Darwin', False)])
def test_posix_install_and_rerun(posix_install, platform, deb):
    result, calls, home = posix_install(platform=platform, deb=deb)
    assert result.returncode == 0, result.stderr
    assert 'installed v1.5.0' in result.stdout
    requests = [call for call in calls if call[0] == 'curl']
    for call in requests:
        assert call[call.index('--proto') + 1] == '=https'
        assert call[call.index('--proto-redir') + 1] == '=https'
    downloads = [call[-1] for call in requests]
    assert downloads[0].endswith('/releases/latest')
    assert all('/releases/download/v1.5.0/' in url for url in downloads[1:])
    sentinel = home / '.local/share/jenny/profile-sentinel'
    sentinel.write_text('keep me', encoding='utf-8')
    result, _, _ = posix_install(platform=platform, deb=deb)
    assert result.returncode == 0, result.stderr
    assert sentinel.read_text() == 'keep me'
    if platform == 'Darwin':
        assert (home / 'Applications/Jenny.app/new-version').exists()
        assert any(call[0] == 'xattr' and call[2] == 'com.apple.quarantine' for call in calls)
    elif deb:
        assert any(call[0] == 'sudo' and 'apt-get' in call and 'install' in call for call in calls)
    else:
        launcher = home / '.local/bin/jenny'
        launched = subprocess.run([str(launcher)], timeout=5, check=False)
        assert launched.returncode == 0
        desktop = (home / '.local/share/applications/jenny.desktop').read_text()
        assert '%% with spaces' in desktop
        assert 'StartupWMClass=jenny' in desktop
        assert 'Icon=jenny' in desktop


@pytest.mark.parametrize('mode', [
    'hash', 'missing', 'duplicate', 'malformed', 'network', 'asset', 'interrupted',
    'tag', 'arch', 'running', 'glibc', 'headless',
])
def test_posix_failures_do_not_install(posix_install, mode):
    result, calls, home = posix_install(mode)
    assert result.returncode != 0
    expected = {
        'hash': 'Checksum mismatch', 'missing': 'Missing, duplicate or malformed',
        'duplicate': 'Missing, duplicate or malformed', 'malformed': 'Missing, duplicate or malformed',
        'network': 'Could not resolve the latest release', 'asset': 'Download failed',
        'interrupted': 'Download failed', 'tag': 'Latest release is not a stable version',
        'arch': 'Unsupported platform', 'running': 'Close Jenny',
        'glibc': 'glibc 2.35 or newer', 'headless': 'Linux desktop session is required',
    }
    assert expected[mode] in result.stderr
    assert not (home / '.local/share/jenny/app/Jenny.AppImage').exists()
    assert not any(call[0] in ('sudo', 'open', 'hdiutil') for call in calls)


def test_appimage_rejects_linked_install_target(posix_install):
    result, _, home = posix_install()
    assert result.returncode == 0, result.stderr
    outside = home / 'outside'
    outside.write_text('preserve', encoding='utf-8')
    target = home / '.local/share/jenny/app/Jenny.AppImage'
    target.unlink()
    target.symlink_to(outside)
    result, _, _ = posix_install()
    assert result.returncode != 0
    assert 'Refusing linked install path' in result.stderr
    assert outside.read_text() == 'preserve'


def test_appimage_refuses_non_file_install_target(posix_install):
    result, _, home = posix_install()
    assert result.returncode == 0, result.stderr
    target = home / '.local/share/jenny/app/Jenny.AppImage'
    target.unlink()
    target.mkdir()
    (target / 'sentinel').write_text('user data', encoding='utf-8')
    launchers = [home / '.local/bin/jenny', home / '.local/share/applications/jenny.desktop']
    before = [path.read_bytes() for path in launchers]
    result, _, _ = posix_install()
    assert result.returncode != 0
    assert 'not a regular file' in result.stderr
    assert 'installed v1.5.0' not in result.stdout
    # Nothing was moved, replaced, launched or deleted.
    assert (target / 'sentinel').read_text(encoding='utf-8') == 'user data'
    assert [path.read_bytes() for path in launchers] == before
    assert not list(target.parent.glob('.stage.*'))


@pytest.mark.parametrize('foreign', [None, '.local/bin/jenny', '.local/share/applications/jenny.desktop'])
def test_deb_after_appimage_launches_and_retargets_packaged_app(posix_install, tmp_path, foreign):
    result, _, home = posix_install()
    assert result.returncode == 0, result.stderr
    old = home / '.local/share/jenny/app/Jenny.AppImage'
    old.write_text('#!/bin/sh\necho appimage >> "$FIXTURE_ROOT/launched"\n', encoding='utf-8')
    if foreign:
        (home / foreign).write_text('foreign launcher bytes', encoding='utf-8')
    bindir = home / '.local/bin'
    # The user's PATH prefers ~/.local/bin over the deb's /usr/bin entry.
    result, _, _ = posix_install(deb=True, extra_env={'PATH': f'{bindir}:{tmp_path / "bin"}'})
    assert result.returncode == 0, result.stderr
    assert 'installed v1.5.0' in result.stdout
    launched = tmp_path / 'launched'
    assert launched.read_text().split() == ['deb']
    packaged = str(tmp_path / 'opt/Jenny/jenny')
    for relative in ('.local/bin/jenny', '.local/share/applications/jenny.desktop'):
        text = (home / relative).read_text(encoding='utf-8')
        if relative == foreign:
            assert text == 'foreign launcher bytes'
        else:
            assert '# Jenny one-command installer' in text
            assert packaged in text and 'Jenny.AppImage' not in text
    if foreign != '.local/bin/jenny':
        subprocess.run([str(bindir / 'jenny')], env=dict(os.environ, FIXTURE_ROOT=str(tmp_path)),
                       timeout=5, check=True)
        assert launched.read_text().split() == ['deb', 'deb']


@pytest.mark.parametrize('absolute', [True, False])
def test_appimage_desktop_entry_follows_xdg_data_home(posix_install, tmp_path, absolute):
    data_home = tmp_path / 'data home \u00fc'
    value = str(data_home) if absolute else 'relative data'
    result, _, home = posix_install(extra_env={'XDG_DATA_HOME': value})
    assert result.returncode == 0, result.stderr
    default = home / '.local/share/applications/jenny.desktop'
    entry = data_home / 'applications/jenny.desktop' if absolute else default
    assert '# Jenny one-command installer' in entry.read_text(encoding='utf-8')
    if absolute:
        assert not default.exists()


def test_appimage_launch_failure_preserves_install(posix_install):
    result, _, home = posix_install('launch')
    assert result.returncode != 0
    assert 'installed but could not start' in result.stderr
    assert (home / '.local/share/jenny/app/Jenny.AppImage').exists()


@pytest.mark.parametrize('platform', ['Linux', 'Darwin'])
@pytest.mark.parametrize('mode', ['replace', 'restore'])
def test_posix_replacement_failure_keeps_previous_app(posix_install, platform, mode):
    result, _, home = posix_install(platform=platform)
    assert result.returncode == 0, result.stderr
    result, _, _ = posix_install(mode, platform=platform)
    assert result.returncode != 0
    if platform == 'Darwin':
        parent = home / 'Applications'
        target = parent / 'Jenny.app'
    else:
        parent = home / '.local/share/jenny/app'
        target = parent / 'Jenny.AppImage'
    if mode == 'replace':
        assert target.exists()
    else:
        assert list(parent.glob('.*stage.*/previous')), 'Failed rollback must retain recovery bytes'
        assert 'restore the previous app' in result.stderr


def test_deb_failure_reported(posix_install):
    result, _, _ = posix_install('install', deb=True)
    assert result.returncode != 0
    assert 'installed v1.5.0' not in result.stdout


def test_mac_open_failure_reports_installed_location(posix_install):
    result, _, home = posix_install('open', platform='Darwin')
    assert result.returncode != 0
    assert 'Installed at' in result.stderr
    assert (home / 'Applications/Jenny.app/new-version').exists()


def test_mac_detach_failure_keeps_mount_and_existing_app(posix_install):
    result, _, home = posix_install('detach', platform='Darwin')
    assert result.returncode != 0
    assert 'could not unmount' in result.stderr
    assert (home / 'Applications/Jenny.app/old-version').exists()
    assert list((home.parent / 'temp').glob('jenny-install.*/mount/Jenny.app'))


POWERSHELL_FIXTURE = r'''
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = Join-Path $env:FIXTURE_ROOT 'local data'
$env:TEMP = Join-Path $env:FIXTURE_ROOT 'temp'
$env:TMP = $env:TEMP
$env:OS = 'Windows_NT'
$env:PROCESSOR_ARCHITECTURE = if ($env:FIXTURE_MODE -eq 'arch') { 'ARM64' } else { 'AMD64' }
$env:PROCESSOR_ARCHITEW6432 = ''
$env:SSH_CONNECTION = ''
New-Item -ItemType Directory -Force $env:LOCALAPPDATA,$env:TEMP | Out-Null
Set-Content -LiteralPath (Join-Path $env:FIXTURE_ROOT 'entered') -Value 'yes'
$script:started = $false
function Invoke-WebRequest {
    [CmdletBinding()]
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec, $MaximumRedirection, [switch]$PassThru)
    Add-Content -LiteralPath (Join-Path $env:FIXTURE_ROOT 'calls') -Value $Uri
    if ($MaximumRedirection -ne 0) { throw 'Automatic redirects must be disabled' }
    if ($env:FIXTURE_MODE -eq 'network') { throw 'network fixture' }
    if ($env:FIXTURE_MODE -eq 'rate_limit') { return [pscustomobject]@{ StatusCode=403; Headers=@{} } }
    if ($Uri -like '*/releases/latest') {
        $target = 'https://github.com/SaltyPretz3l/jenny/releases/tag/v1.5.0'
        if ($env:FIXTURE_MODE -eq 'http_release') { $target = $target.Replace('https:', 'http:') }
        Write-Output ([pscustomobject]@{ StatusCode=302; Headers=@{Location=$target} })
        if ($env:FIXTURE_MODE -eq 'redirect_error') {
            Write-Error 'The maximum redirection count has been exceeded.' -ErrorId 'MaximumRedirectExceeded'
        }
        return
    } elseif ($Uri -like '*/releases/tag/*') {
        return [pscustomobject]@{ StatusCode=200; Headers=@{} }
    } elseif ($Uri -like '*SHA256SUMS*') {
        if ($env:FIXTURE_MODE -eq 'http_asset') { return [pscustomobject]@{StatusCode=302; Headers=@{Location='http://example.invalid/hash'}} }
        $hash = (Get-FileHash -LiteralPath (Join-Path $env:FIXTURE_ROOT 'payload') -Algorithm SHA256).Hash
        if ($env:FIXTURE_MODE -eq 'hash') { $hash = '0' * 64 }
        if ($env:FIXTURE_MODE -eq 'malformed') { $hash = 'bad' }
        $line = "$hash  Jenny-Setup-x64.exe"
        if ($env:FIXTURE_MODE -eq 'missing') { $line = '' }
        if ($env:FIXTURE_MODE -eq 'duplicate') { $line += [Environment]::NewLine + $line }
        Set-Content -LiteralPath $OutFile -Value $line
    } else {
        if ($env:FIXTURE_MODE -eq 'asset') { throw 'missing asset fixture' }
        Copy-Item -LiteralPath (Join-Path $env:FIXTURE_ROOT 'payload') -Destination $OutFile
        if ($env:FIXTURE_MODE -eq 'interrupted') { throw 'interrupted transfer fixture' }
    }
    return [pscustomobject]@{ StatusCode=200; Headers=@{} }
}
function Get-Process {
    param($Name, $Id, $ErrorAction)
    if ($Id) { return [pscustomobject]@{SessionId=1} }
    if ($env:FIXTURE_MODE -eq 'running' -or $script:started) { return [pscustomobject]@{Name='Jenny'} }
}
function Start-Sleep { param($Seconds) }
function Start-Process {
    param($FilePath, [switch]$Wait, [switch]$PassThru)
    if ($Wait) { throw 'Do not wait for the launched app process tree' }
    Add-Content -LiteralPath (Join-Path $env:FIXTURE_ROOT 'started') -Value $FilePath
    if ($FilePath -like '*Jenny-Setup-x64.exe') {
        $zone = Get-Content -LiteralPath $FilePath -Stream Zone.Identifier -Raw
        if ($zone -notmatch 'ZoneId=3') { throw 'Missing Mark of the Web' }
        $app = Join-Path $env:LOCALAPPDATA 'Programs/Jenny'
        New-Item -ItemType Directory -Force $app | Out-Null
        Set-Content -LiteralPath (Join-Path $app 'Jenny.exe') -Value 'fixture app'
        $process = [pscustomobject]@{ExitCode=0}
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
        if ($env:FIXTURE_MODE -eq 'install') { $process.ExitCode=1; return $process }
        if ($env:FIXTURE_MODE -eq 'autostart') { $script:started=$true }
        return $process
    }
}
function Get-ItemProperty { param($Path, $ErrorAction) }
try {
    # Same execution mechanism as irm | iex; network/OS commands are mocked.
    Get-Content -LiteralPath $env:INSTALL_SCRIPT -Raw | Invoke-Expression
} catch { Write-Output $_; exit 1 }
'''


@pytest.mark.parametrize('mode', [
    '', 'autostart', 'redirect_error', 'hash', 'missing', 'duplicate', 'malformed', 'network',
    'asset', 'interrupted', 'arch', 'running', 'install', 'rate_limit', 'http_release', 'http_asset',
])
def test_powershell_entrypoint(tmp_path: Path, mode):
    if sys.platform != 'win32':
        pytest.skip('Windows ADS and Windows PowerShell are required.')
    shell = shutil.which('powershell.exe')
    assert shell, 'Windows PowerShell 5.1 must be tested'
    (tmp_path / 'payload').write_bytes(b'harmless installer fixture')
    env = dict(os.environ, FIXTURE_ROOT=str(tmp_path), FIXTURE_MODE=mode, INSTALL_SCRIPT=str(ROOT / 'install.ps1'))
    # Python can inherit PowerShell 7's module paths from the driving shell.
    # Let Windows PowerShell initialize its own native 5.1 module paths.
    env = {key: value for key, value in env.items() if key.lower() != 'psmodulepath'}
    command = base64.b64encode(POWERSHELL_FIXTURE.encode('utf-16le')).decode('ascii')
    result = subprocess.run([shell, '-NoProfile', '-EncodedCommand', command], env=env,
                            capture_output=True, text=True, timeout=30, check=False)
    assert (tmp_path / 'entered').exists(), result.stdout + result.stderr
    success = mode in ('', 'autostart', 'redirect_error')
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    assert not list((tmp_path / 'temp').glob('jenny-install-*'))
    started = tmp_path / 'started'
    if success:
        assert len(started.read_text().splitlines()) == (1 if mode == 'autostart' else 2)
        calls = (tmp_path / 'calls').read_text().splitlines()
        assert calls[0] == 'https://github.com/SaltyPretz3l/jenny/releases/latest'
        assert not any('api.github.com' in url for url in calls)
        assert all('/releases/download/v1.5.0/' in url for url in calls[2:])
    elif mode != 'install':
        assert not started.exists()
    if not success:
        expected = {
            'hash': 'Checksum mismatch', 'missing': 'Missing, duplicate or malformed',
            'duplicate': 'Missing, duplicate or malformed', 'malformed': 'Missing, duplicate or malformed',
            'network': 'HTTPS request failed', 'asset': 'Download failed',
            'rate_limit': 'HTTP 403', 'http_release': 'non-HTTPS', 'http_asset': 'non-HTTPS',
            'interrupted': 'Download failed', 'arch': 'requires Windows x64',
            'running': 'Close Jenny', 'install': 'Installer exited with code 1',
        }
        assert expected[mode] in result.stdout + result.stderr
    else:
        sentinel = tmp_path / 'local data/profile-sentinel'
        sentinel.write_text('preserve', encoding='utf-8')
        second = subprocess.run([shell, '-NoProfile', '-EncodedCommand', command], env=env,
                                capture_output=True, text=True, timeout=30, check=False)
        assert second.returncode == 0, second.stdout + second.stderr
        assert sentinel.read_text() == 'preserve'


@pytest.mark.parametrize('relative', ['.local/bin/jenny', '.local/share/applications/jenny.desktop'])
def test_foreign_launcher_is_preserved(posix_install, relative):
    result, _, home = posix_install()
    assert result.returncode == 0, result.stderr
    foreign = home / relative
    foreign.write_text('foreign launcher bytes', encoding='utf-8')
    result, _, _ = posix_install()
    assert result.returncode != 0
    assert 'Existing launcher is not owned' in result.stderr
    assert foreign.read_text() == 'foreign launcher bytes'


def test_mac_attach_failure_cleans_download_without_detach(posix_install):
    result, calls, home = posix_install('attach', platform='Darwin')
    assert result.returncode != 0
    assert 'Could not attach the Jenny disk image' in result.stderr
    assert 'could not unmount' not in result.stderr
    assert not any(call[:2] == ['hdiutil', 'detach'] for call in calls)
    assert (home / 'Applications/Jenny.app/old-version').exists()


def test_cleanup_failure_still_releases_install_lock(posix_install):
    result, _, home = posix_install('cleanup')
    assert result.returncode == 0, result.stderr
    assert not (home / '.local/share/jenny/.install-lock').exists()


@pytest.mark.parametrize('mode', ['launcher', 'desktop'])
def test_launcher_publication_failure_precedes_app_replacement(posix_install, mode):
    result, _, home = posix_install()
    assert result.returncode == 0, result.stderr
    target = home / '.local/share/jenny/app/Jenny.AppImage'
    target.write_text('previous app', encoding='utf-8')
    result, _, _ = posix_install(mode)
    assert result.returncode != 0
    assert 'Could not publish' in result.stderr
    assert target.read_text() == 'previous app'


def test_debian_without_sudo_uses_appimage(posix_install):
    result, calls, home = posix_install(deb=True, without_sudo=True)
    assert result.returncode == 0, result.stderr
    assert (home / '.local/share/jenny/app/Jenny.AppImage').exists()
    assert not any(call[0] == 'sudo' for call in calls)
