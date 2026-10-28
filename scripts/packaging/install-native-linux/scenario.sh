#!/bin/sh
# In-container scenario for scripts/packaging/install-native-linux.sh (row 47).
# Runs as the non-root `tester` user. The real installer is bind-mounted read-only
# at /work/install.sh. Environment: JENNY_ROUTE (deb|appimage), JENNY_PRIOR_TAG
# (optional vX.Y.Z installed first as the upgrade source).
set -u

route=${JENNY_ROUTE:-}
prior=${JENNY_PRIOR_TAG:-}
installer=/work/install.sh
repo=https://github.com/SaltyPretz3l/jenny
marker='# Jenny one-command installer'
refusal_msg='Close Jenny, then rerun this command. No running process was stopped.'
profile=$HOME/.config/jenny
shell_log=$profile/logs/shell.log
data=$HOME/.local/share/jenny
appimage=$data/app/Jenny.AppImage
bindir=$HOME/.local/bin
desktopdir=$HOME/.local/share/applications
tmp=$(mktemp -d)
step=setup
tag=none install_s=none boot_ms=none refusal=skip rerun=skip preserved=skip

case "$route" in
    deb) asset=Jenny-amd64.deb ;;
    appimage) asset=Jenny-x86_64.AppImage ;;
    *) echo "FAIL route=$route step=setup: JENNY_ROUTE must be deb or appimage"; exit 2 ;;
esac

say() { printf '== [%s/%s] %s\n' "$route" "$step" "$*"; }
fail() {
    printf 'FAIL route=%s step=%s: %s\n' "$route" "$step" "$*"
    if [ -f "$shell_log" ]; then
        say "last shell.log lines:"
        tail -n 15 "$shell_log" | cut -c1-400
    fi
    say "processes:"
    ps -eo pid,ppid,stat,comm,args | cut -c1-200
    printf 'RESULT route=%s tag=%s prior=%s status=fail step=%s\n' "$route" "$tag" "${prior:-none}" "$step"
    exit 1
}
now() { date +%s; }
log_lines() { if [ -f "$shell_log" ]; then wc -l <"$shell_log" | tr -d ' '; else echo 0; fi; }
# Alive means present and not a zombie.
is_alive() {
    ia_stat=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
    case "$ia_stat" in ''|Z*) return 1 ;; esac
    return 0
}
app_running() { pgrep -x jenny >/dev/null 2>&1 || pgrep -x Jenny.AppImage >/dev/null 2>&1; }
# The oldest `jenny` process is the Electron browser (main) process.
main_pid() { pgrep -o -x jenny 2>/dev/null; }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
fetch() { # url, destination
    curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --connect-timeout 15 --max-time 1800 -o "$2" "$1"
}
manifest_hash() { # manifest file, asset name
    awk -v name="$2" '$2 == name {count++; hash=tolower($1)} END {if (count != 1 || length(hash) != 64) exit 1; print hash}' "$1"
}

# Wait up to 90 s for a successful window.ready (source ready-to-show or
# did-finish-load; renderer-ready forms from earlier builds) and backend.managed_sidecar_initialized from ONE run
# among the shell.log lines written after line offset $1 (markers.sh decides).
# Sets boot_ms and run_id; a failed renderer start fails immediately.
markers=$(dirname "$0")/markers.sh
wait_markers() {
    wm_offset=$1
    wm_deadline=$(( $(now) + 90 ))
    while :; do
        wm_out=$(sh "$markers" "$shell_log" "$wm_offset")
        wm_rc=$?
        case "$wm_rc" in
            0)
                run_id=${wm_out#run_id=}; run_id=${run_id%% *}
                boot_ms=${wm_out##*boot_ms=}
                return 0 ;;
            2) fail "renderer start failed: $wm_out" ;;
        esac
        [ "$(now)" -lt "$wm_deadline" ] || return 1
        sleep 1
    done
}

# Boot check after a launch: markers, then the main process must still be alive.
# Sets app_pid.
await_boot() { # offset
    wait_markers "$1" || fail "window.ready + backend.managed_sidecar_initialized not seen for one run within 90 s"
    app_pid=$(main_pid) || fail "markers seen but no jenny process is running"
    sleep 2
    is_alive "$app_pid" || fail "jenny main process $app_pid exited after the markers"
    say "booted: run_id=$run_id startupMs=$boot_ms main_pid=$app_pid"
}

# Stop by PID: SIGTERM, wait up to 20 s, SIGKILL as a last resort; then require that
# no jenny (or AppImage runtime) process remains. $2 optionally names our own child
# to reap so it does not linger as a zombie.
stop_app() { # pid [child]
    kill -TERM "$1" 2>/dev/null || true
    sa_deadline=$(( $(now) + 20 ))
    while is_alive "$1" && [ "$(now)" -lt "$sa_deadline" ]; do sleep 1; done
    if is_alive "$1"; then
        say "main process $1 ignored SIGTERM for 20 s; sending SIGKILL"
        kill -KILL "$1" 2>/dev/null || true
    fi
    if [ $# -ge 2 ]; then wait "$2" 2>/dev/null || true; fi
    sa_deadline=$(( $(now) + 15 ))
    while app_running && [ "$(now)" -lt "$sa_deadline" ]; do sleep 1; done
    if app_running; then fail "jenny processes remain after stopping $1: $(pgrep -a -x jenny; pgrep -a -x Jenny.AppImage)"; fi
    say "stopped pid $1; no jenny process remains"
}

snapshot() { # destination file
    [ -f "$profile/profile-owner.json" ] || fail "profile-owner.json missing from $profile"
    {
        echo "owner=$(sha_of "$profile/profile-owner.json")"
        if [ -f "$profile/shell-config.json" ]; then echo shell_config=present; else echo shell_config=missing; fi
        if [ -d "$profile/sessions" ]; then
            # name=sha256 per file (directories by name), so a rerun proves contents survived.
            (cd "$profile/sessions" && find . -mindepth 1 | LC_ALL=C sort | while IFS= read -r entry; do
                if [ -f "$entry" ]; then printf 'session=%s=%s\n' "${entry#./}" "$(sha_of "$entry")"
                else printf 'session=%s\n' "${entry#./}"; fi
            done)
        else
            echo sessions=missing
        fi
    } >"$1"
}

# Settings preservation: seed non-default values on a stopped profile, verify later.
seed_settings() {
    cfg=$profile/shell-config.json
    [ -f "$cfg" ] || fail "cannot seed settings: $cfg is missing"
    jq '.windowUi.appZoomPercent = 125 | .use24HourTime = true' "$cfg" >"$tmp/cfg.json" || fail 'jq could not rewrite shell-config.json'
    mv "$tmp/cfg.json" "$cfg"
    say 'seeded settings: windowUi.appZoomPercent=125, use24HourTime=true'
}
check_settings() { # label
    jq -e '.windowUi.appZoomPercent == 125 and .use24HourTime == true' "$profile/shell-config.json" >/dev/null \
        || fail "seeded settings did not survive the $1: $(jq -c '{zoom: .windowUi.appZoomPercent, h24: .use24HourTime}' "$profile/shell-config.json" 2>/dev/null)"
    say "seeded settings survived the $1"
}

no_leftovers() {
    if [ -d "$data/app" ]; then
        st_left=$(find "$data/app" -mindepth 1 -maxdepth 1 -name '.stage.*' | head -n 5)
        [ -z "$st_left" ] || fail "staging directories remain: $st_left"
    fi
    [ ! -e "$data/.install-lock" ] || fail "leftover $data/.install-lock"
}

run_installer() { # output file; sets inst_status and inst_secs
    ri_start=$(now)
    sh "$installer" >"$1" 2>&1
    inst_status=$?
    inst_secs=$(( $(now) - ri_start ))
    sed 's/^/  install.sh| /' "$1"
    say "install.sh exit=$inst_status after ${inst_secs}s"
}

# When the AppImage did not start, record its own stderr once for the report.
appimage_diagnostic() {
    [ "$route" = appimage ] && [ -f "$appimage" ] || return 0
    say "diagnostic: running $appimage directly for up to 15 s (APPIMAGE_EXTRACT_AND_RUN=${APPIMAGE_EXTRACT_AND_RUN:-unset})"
    timeout 15 "$appimage" >"$tmp/diag.out" 2>&1
    say "diagnostic exit=$?; output tail:"
    tail -n 25 "$tmp/diag.out" | cut -c1-300
}

write_launchers() { # executable (a plain path; mirrors install.sh's owned launchers)
    mkdir -p "$bindir" "$desktopdir"
    printf '#!/bin/sh\n%s\nexec '\''%s'\'' "$@"\n' "$marker" "$1" >"$bindir/jenny"
    chmod 755 "$bindir/jenny"
    printf '%s\n[Desktop Entry]\nType=Application\nName=Jenny\nExec="%s" %%U\nTerminal=false\nIcon=jenny\nStartupWMClass=jenny\nCategories=Development;\n' \
        "$marker" "$1" >"$desktopdir/jenny.desktop"
    chmod 644 "$desktopdir/jenny.desktop"
}

# ---- desktop session: Xvfb and dbus must outlive every install.sh run ----
say "user=$(id -un) kernel=$(uname -r) glibc=$(getconf GNU_LIBC_VERSION) os=$(. /etc/os-release && echo "$PRETTY_NAME")"
if [ -x /usr/local/bin/uname ]; then say "NOTICE: uname -r is shimmed in this image (WSL2 Docker kernel on the host)"; fi
Xvfb :99 -screen 0 1280x960x24 -nolisten tcp >"$tmp/xvfb.log" 2>&1 &
deadline=$(( $(now) + 15 ))
while [ ! -S /tmp/.X11-unix/X99 ] && [ "$(now)" -lt "$deadline" ]; do sleep 1; done
[ -S /tmp/.X11-unix/X99 ] || fail "Xvfb :99 did not start: $(cat "$tmp/xvfb.log")"
export DISPLAY=:99
eval "$(dbus-launch --sh-syntax)" || fail "dbus-launch failed"
export DBUS_SESSION_BUS_ADDRESS

# ---- a. optional prior release ----
if [ -n "$prior" ]; then
    step=prior-download
    pdir=$(mktemp -d)
    chmod 755 "$pdir"
    pbase=$repo/releases/download/$prior
    fetch "$pbase/SHA256SUMS-linux.txt" "$pdir/SHA256SUMS-linux.txt" || fail "could not download $prior SHA256SUMS-linux.txt"
    pexpected=$(manifest_hash "$pdir/SHA256SUMS-linux.txt" "$asset") || fail "no single $asset entry in $prior SHA256SUMS-linux.txt"
    fetch "$pbase/$asset" "$pdir/$asset" || fail "could not download $prior $asset"
    [ "$(sha_of "$pdir/$asset")" = "$pexpected" ] || fail "$prior $asset checksum mismatch"
    chmod 644 "$pdir/$asset"
    say "verified $prior $asset ($pexpected)"
    step=prior-install
    if [ "$route" = deb ]; then
        sudo -n apt-get install -y "$pdir/$asset" >"$tmp/prior-apt.out" 2>&1 \
            || { tail -n 20 "$tmp/prior-apt.out"; fail "apt-get install of $prior failed"; }
        pver=$(dpkg-query -W -f='${Version}' jenny 2>/dev/null)
        [ "$pver" = "${prior#v}" ] || fail "dpkg reports jenny '$pver', expected ${prior#v}"
        papp=/opt/Jenny/jenny
    else
        mkdir -p "$data/app"
        cp "$pdir/$asset" "$appimage"
        chmod 755 "$appimage"
        write_launchers "$appimage"
        papp=$appimage
    fi
    rm -rf "$pdir"
    step=prior-boot
    off=$(log_lines)
    nohup "$papp" >"$tmp/prior-app.out" 2>&1 &
    launched=$!
    await_boot "$off"
    prior_boot_ms=$boot_ms
    step=prior-stop
    stop_app "$app_pid" "$launched"
    seed_settings
    snapshot "$tmp/snap-prior"
    say "prior $prior booted in ${prior_boot_ms} ms; profile snapshot:"
    sed 's/^/  /' "$tmp/snap-prior"
fi

# ---- b. real install.sh ----
step=install
off=$(log_lines)
run_installer "$tmp/install.out"
install_s=$inst_secs
if [ "$inst_status" != 0 ]; then
    appimage_diagnostic
    fail "install.sh exited $inst_status"
fi
tag=$(sed -n 's/^Jenny: installed \(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)\. .*/\1/p' "$tmp/install.out" | head -n 1)
[ -n "$tag" ] || { tag=none; fail "no 'Jenny: installed vX.Y.Z.' line in the installer output"; }

# ---- c. boot to onboarding ----
step=boot
await_boot "$off"
first_boot_ms=$boot_ms

# ---- d. route assertions ----
step=assert-$route
if [ "$route" = deb ]; then
    ver=$(dpkg-query -W -f='${Version}' jenny 2>/dev/null)
    [ "$ver" = "${tag#v}" ] || fail "dpkg reports jenny '$ver', expected ${tag#v}"
    [ -f /opt/Jenny/jenny ] && [ -x /opt/Jenny/jenny ] || fail "/opt/Jenny/jenny is not an executable file"
    resolved=$(readlink -f /usr/bin/jenny 2>/dev/null)
    [ -n "$resolved" ] && [ -x "$resolved" ] || fail "/usr/bin/jenny does not resolve to an executable"
    say "dpkg jenny=$ver; /usr/bin/jenny -> $resolved"
else
    [ -f "$appimage" ] && [ ! -L "$appimage" ] || fail "$appimage is not a regular file"
    fetch "$repo/releases/download/$tag/SHA256SUMS-linux.txt" "$tmp/SHA256SUMS-linux.txt" || fail "could not download $tag SHA256SUMS-linux.txt"
    expected=$(manifest_hash "$tmp/SHA256SUMS-linux.txt" "$asset") || fail "no single $asset entry in $tag SHA256SUMS-linux.txt"
    [ "$(sha_of "$appimage")" = "$expected" ] || fail "$appimage does not match the $tag manifest hash"
    for f in "$bindir/jenny" "$desktopdir/jenny.desktop"; do
        [ -f "$f" ] || fail "missing launcher $f"
        grep -qxF "$marker" "$f" || fail "$f lacks the marker line"
        grep -qF "$appimage" "$f" || fail "$f does not point at $appimage"
    done
    no_leftovers
    say "AppImage sha256 matches $tag manifest; both owned launchers point at it"
fi

# ---- e. running-app refusal ----
step=refusal
sh "$installer" >"$tmp/refusal.out" 2>"$tmp/refusal.err"
ref_status=$?
sed 's/^/  install.sh(stdout)| /' "$tmp/refusal.out"
sed 's/^/  install.sh(stderr)| /' "$tmp/refusal.err"
[ "$ref_status" = 1 ] || fail "install.sh exited $ref_status with Jenny running, expected 1"
grep -qF "$refusal_msg" "$tmp/refusal.err" || fail "stderr lacks the running-app refusal message"
is_alive "$app_pid" || fail "jenny main process $app_pid died during the refused install"
[ ! -e "$data/.install-lock" ] || fail "leftover $data/.install-lock after the refusal"
refusal=ok

# ---- f. stop by PID ----
step=stop
stop_app "$app_pid"

if [ -n "$prior" ]; then
    step=upgrade-preserved
    snapshot "$tmp/snap-upgraded"
    grep '^owner=' "$tmp/snap-prior" | grep -qxFf - "$tmp/snap-upgraded" || fail "profile-owner.json changed across the $prior -> $tag upgrade"
    grep -qx shell_config=present "$tmp/snap-upgraded" || fail "shell-config.json missing after the upgrade"
    # A version upgrade may migrate session contents; every prior entry must still exist by exact name.
    grep '^session=' "$tmp/snap-prior" | sed 's/=[0-9a-f]\{64\}$//' | LC_ALL=C sort >"$tmp/names-prior"
    grep '^session=' "$tmp/snap-upgraded" | sed 's/=[0-9a-f]\{64\}$//' | LC_ALL=C sort >"$tmp/names-upgraded"
    lost=$(grep -vxF -f "$tmp/names-upgraded" "$tmp/names-prior")
    [ -z "$lost" ] || fail "sessions lost across the upgrade: $lost"
    check_settings "$prior -> $tag upgrade"
    say "upgrade $prior -> $tag kept profile-owner.json, shell-config.json and every prior session entry"
fi
[ -n "$prior" ] || seed_settings
snapshot "$tmp/snap-installed"

# ---- g. rerun on the existing installation and profile ----
step=rerun
off=$(log_lines)
run_installer "$tmp/rerun.out"
[ "$inst_status" = 0 ] || fail "rerun install.sh exited $inst_status"
grep -qF "Jenny: installed $tag." "$tmp/rerun.out" || fail "rerun output lacks 'Jenny: installed $tag.'"
await_boot "$off"
snapshot "$tmp/snap-rerun"
# The rerun boot may add session files; what existed before must survive with identical contents.
grep '^owner=' "$tmp/snap-installed" | grep -qxFf - "$tmp/snap-rerun" || fail "profile-owner.json changed across the rerun"
grep -qx shell_config=present "$tmp/snap-rerun" || fail "shell-config.json missing after the rerun"
lost=$(grep '^session=' "$tmp/snap-installed" | grep -vxF -f "$tmp/snap-rerun")
[ -z "$lost" ] || fail "sessions lost across the rerun: $lost"
check_settings rerun
no_leftovers
step=rerun-stop
stop_app "$app_pid"
rerun=ok
preserved=ok

step=done
printf 'RESULT route=%s tag=%s prior=%s install_s=%s boot_ms=%s refusal=%s rerun=%s preserved=%s\n' \
    "$route" "$tag" "${prior:-none}" "$install_s" "$first_boot_ms" "$refusal" "$rerun" "$preserved"
