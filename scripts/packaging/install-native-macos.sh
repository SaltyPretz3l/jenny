#!/bin/sh
# Real-install harness for the macOS one-command installer (row 47).
# CI only: this INSTALLS Jenny. Run it only on a disposable Apple Silicon runner:
#   sh scripts/packaging/install-native-macos.sh
# The build is unsigned and not notarized. This harness never removes quarantine and never
# changes Gatekeeper; boot and onboarding on macOS remain an owner gate.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd -P)
log_dir=$repo_root/artifacts/logs
mkdir -p "$log_dir"
log=$log_dir/install-native-macos.log
: > "$log"
step=init

say() {
    line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$step] $*"
    printf '%s\n' "$line" >> "$log"
    printf '%s\n' "$line"
}
die() {
    say "FAILED: step $step failed: $*"
    exit 1
}

# Runs install.sh; sets install_exit, install_out, install_err and launch.
run_install() {
    label=$1
    install_out=$log_dir/install-native-macos-$label.out.log
    install_err=$log_dir/install-native-macos-$label.err.log
    if sh "$repo_root/install.sh" > "$install_out" 2> "$install_err"; then
        install_exit=0
    else
        install_exit=$?
    fi
    say "install.sh ($label) exit=$install_exit"
    say "stdout: $(cat "$install_out")"
    say "stderr: $(cat "$install_err")"
    if [ "$install_exit" = 0 ]; then
        launch=exit0
    elif [ "$install_exit" = 1 ] && grep -q 'Installed at' "$install_err" &&
        grep -q 'complete the macOS security prompt' "$install_err"; then
        launch=gatekeeper
    else
        die "install.sh ($label) did not reach launch"
    fi
}

find_app() {
    app=
    count=0
    for candidate in /Applications/Jenny.app "$HOME/Applications/Jenny.app"; do
        if [ -e "$candidate" ]; then
            app=$candidate
            count=$((count + 1))
        fi
    done
    [ "$count" = 1 ] || die "expected exactly one installed Jenny.app, found $count"
    [ -d "$app/Contents" ] || die "$app is not an app bundle"
}

inspect_app() {
    quarantine=$(xattr -p com.apple.quarantine "$app" 2>/dev/null) || die "com.apple.quarantine is not set on $app"
    say "bundle=$app quarantine=$quarantine"
    say "spctl: $(spctl --assess --type execute --verbose "$app" 2>&1 || true)"
    say "codesign: $(codesign -dv "$app" 2>&1 || true)"
    parent=$(dirname "$app")
    for leftover in "$parent"/.jenny-stage.*; do
        [ ! -e "$leftover" ] || die "staging leftover $leftover"
    done
    for volume in /Volumes/Jenny*; do
        [ ! -e "$volume" ] || die "disk image still attached at $volume"
    done
    if hdiutil info | grep -q 'jenny-install\.'; then
        die 'a jenny-install disk image is still attached'
    fi
}

# A launch may have started Jenny; stop only PIDs whose executable is inside the bundle.
stop_jenny() {
    pids=$(pgrep -x Jenny || true)
    for pid in $pids; do
        command_path=$(ps -o comm= -p "$pid" 2>/dev/null || true)
        case "$command_path" in
            "$app"/Contents/MacOS/*) ;;
            *) say "ignoring pid=$pid ($command_path): not inside $app"; continue ;;
        esac
        say "stopping Jenny pid=$pid"
        kill -TERM "$pid" 2>/dev/null || true
        waited=0
        while kill -0 "$pid" 2>/dev/null; do
            if [ "$waited" -ge 30 ]; then
                say "pid=$pid still running after 30 s; sending KILL"
                kill -KILL "$pid" 2>/dev/null || true
                sleep 2
                break
            fi
            sleep 1
            waited=$((waited + 1))
        done
        ! kill -0 "$pid" 2>/dev/null || die "Jenny pid=$pid did not exit"
    done
    ! pgrep -x Jenny > /dev/null 2>&1 || die 'a Jenny process is still running'
}

step=a-precondition
# Disposable machines only: this installs and replaces Jenny for the current user.
if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${JENNY_INSTALL_NATIVE_DISPOSABLE:-}" != 1 ]; then
    die 'refusing to run outside GitHub Actions; set JENNY_INSTALL_NATIVE_DISPOSABLE=1 only on a throwaway machine'
fi
say "macOS $(sw_vers -productVersion 2>/dev/null || echo unknown) arch=$(uname -m) user=$(id -un)"
! pgrep -x Jenny > /dev/null 2>&1 || die 'a Jenny process is already running'
[ -f "$repo_root/install.sh" ] || die 'install.sh is missing'

step=b-install
run_install first
first_launch=$launch
tag=$(sed -n 's/^Jenny: downloading Jenny-arm64\.dmg from \(v[0-9][0-9.]*\)\.\.\.$/\1/p' "$install_out" | head -n 1)
[ -n "$tag" ] || die 'install.sh did not report the release tag'
say "tag=$tag launch=$first_launch"

step=c-inspect
find_app
inspect_app
first_inode=$(stat -f %i "$app")
say "bundle inode=$first_inode"

step=d-stop
stop_jenny

step=e-rerun
run_install rerun
find_app
inspect_app
second_inode=$(stat -f %i "$app")
say "bundle inode=$second_inode"
[ "$second_inode" != "$first_inode" ] || die 'the rerun did not replace the bundle'
stop_jenny

step=f-finish
say "RESULT platform=macos tag=$tag launch=$first_launch rerun=ok"
exit 0
