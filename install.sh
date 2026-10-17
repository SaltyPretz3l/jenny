#!/bin/sh
# Install released Jenny packages. Source/developer setup lives in setup.sh.
# Run: curl -fsSL https://raw.githubusercontent.com/SaltyPretz3l/jenny/main/install.sh | sh
install_jenny() (
    set -eu
    umask 077
    repo=https://github.com/SaltyPretz3l/jenny
    work= lock= mount= stage= backup= target=
    replacing=0
    fail() { printf 'Jenny: %s\n' "$*" >&2; exit 1; }
    need() { command -v "$1" >/dev/null 2>&1 || fail "Install $1, then rerun this command."; }
    cleanup() {
        status=$?
        set +e # Cleanup must release the lock even if a preceding removal fails.
        trap - EXIT HUP INT TERM
        if [ "$replacing" = 1 ] && [ -n "$backup" ] && [ -e "$backup" ]; then
            if [ ! -e "$target" ]; then
                if ! mv "$backup" "$target"; then
                    printf 'Jenny: restore the previous app from %s\n' "$backup" >&2
                    stage= # Keep the recovery copy if automatic restoration failed.
                fi
            fi
        fi
        if [ -n "$mount" ] && ! hdiutil detach "$mount" >/dev/null 2>&1; then
            printf 'Jenny: could not unmount %s. Eject it in Finder before removing its temporary directory.\n' "$mount" >&2
            work= # Never recursively clean an attached volume.
        fi
        if [ -n "$stage" ]; then
            rm -rf "$stage" || printf 'Jenny: could not remove temporary staging directory %s.\n' "$stage" >&2
        fi
        if [ -n "$work" ]; then
            rm -rf "$work" || printf 'Jenny: could not remove temporary download directory %s.\n' "$work" >&2
        fi
        if [ -n "$lock" ]; then rmdir "$lock" 2>/dev/null || true; fi
        exit "$status"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' HUP TERM
    need curl
    need awk
    need mktemp
    need pgrep
    [ "$(id -u)" != 0 ] || fail 'Run as your desktop user, without sudo. Only apt will request elevation.'
    [ -z "${SSH_CONNECTION:-}" ] || fail 'Run in a local desktop terminal, not an SSH session.'
    [ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail 'A home directory is required.'
    user_home=$(cd "$HOME" && pwd -P)
    case "$user_home" in *'
'*) fail 'Home paths containing newlines are unsupported.' ;; esac

    # Do not follow links in directories we will install into or remove from.
    safe_path() {
        check=$1
        while [ "$check" != / ]; do
            [ ! -L "$check" ] || fail "Refusing linked install path: $check"
            check=$(dirname "$check")
        done
    }
    app_closed() {
        for name in Jenny jenny; do
            if pgrep -x "$name" >/dev/null 2>&1; then
                fail 'Close Jenny, then rerun this command. No running process was stopped.'
            else
                result=$?
                [ "$result" = 1 ] || fail 'Could not check whether Jenny is running.'
            fi
        done
    }
    os=$(uname -s)
    arch=$(uname -m)
    case "$os/$arch" in
        Linux/x86_64)
            [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || fail 'A Linux desktop session is required.'
            case "$(uname -r)" in *[Mm]icrosoft*|*WSL*) fail 'Use the Windows PowerShell installer outside WSL.' ;; esac
            need getconf
            glibc=$(getconf GNU_LIBC_VERSION) || fail 'A glibc Linux distribution is required.'
            printf '%s\n' "$glibc" | awk '$1 == "glibc" { split($2,v,"."); if (v[1]>2 || (v[1]==2 && v[2]>=35)) ok=1 } END {exit !ok}' || fail 'Jenny requires glibc 2.35 or newer.'
            platform=linux
            kind=appimage
            # Read values as data: never source an external file as shell code.
            distro=$(awk -F= '/^(ID|ID_LIKE)=/ {gsub(/["\047]/,"",$2); print $2}' /etc/os-release)
            case " $(printf '%s' "$distro" | tr '\n' ' ') " in
                *' debian '*|*' ubuntu '*) kind=deb ;;
            esac
            if [ "$kind" = deb ] && command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
                asset=Jenny-amd64.deb
            else
                kind=appimage
                asset=Jenny-x86_64.AppImage
            fi
            need sha256sum
            bindir=$user_home/.local/bin
            # XDG_DATA_HOME counts only when absolute; otherwise use its default. A newline
            # would hide a linked parent from safe_path (dirname strips it), as for HOME.
            data_home=$user_home/.local/share
            case "${XDG_DATA_HOME:-}" in *'
'*) fail 'XDG_DATA_HOME paths containing newlines are unsupported.' ;; /*) data_home=$XDG_DATA_HOME ;; esac
            desktopdir=$data_home/applications
            ;;
        Darwin/arm64)
            need hdiutil
            need ditto
            need shasum
            need xattr
            need open
            launchctl print "gui/$(id -u)" >/dev/null 2>&1 || fail 'Log in to the Mac desktop and run this in Terminal.'
            platform=mac
            kind=mac
            asset=Jenny-arm64.dmg
            ;;
        *) fail "Unsupported platform $os/$arch. Packages support Windows x64, Linux x64 and Apple Silicon macOS. See $repo/releases." ;;
    esac
    app_closed
    printf 'Jenny: installing latest stable release (%s; experimental).\n' "$platform"
    safe_path "$user_home/.local/share/jenny"
    mkdir -p "$user_home/.local/share/jenny"
    candidate_lock=$user_home/.local/share/jenny/.install-lock
    mkdir "$candidate_lock" 2>/dev/null || fail "Another install may be active. If it was interrupted, remove the empty $candidate_lock directory and retry."
    lock=$candidate_lock
    work=$(mktemp -d "${TMPDIR:-/tmp}/jenny-install.XXXXXXXX")
    # Resolve once, then pin both package and manifest to this tag (not /latest).
    release=$(curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --connect-timeout 15 --max-time 60 -o /dev/null -w '%{url_effective}' "$repo/releases/latest") || fail 'Could not resolve the latest release. Check your network and retry.'
    tag=${release#"$repo/releases/tag/"}
    [ "$tag" != "$release" ] || fail 'Unexpected release redirect.'
    printf '%s\n' "$tag" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/ {ok=1} END {exit !ok}' || fail 'Latest release is not a stable version.'
    base=$repo/releases/download/$tag
    download() {
        curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --connect-timeout 15 --max-time 1800 -o "$work/$1" "$base/$1" || fail "Download failed: $1. Retry, or use $repo/releases/tag/$tag."
    }
    printf 'Jenny: downloading %s from %s...\n' "$asset" "$tag"
    download "SHA256SUMS-$platform.txt"
    expected=$(awk -v name="$asset" '$2 == name {count++; hash=$1; if (NF != 2 || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) bad=1} END {if (count != 1 || bad) exit 1; print tolower(hash)}' "$work/SHA256SUMS-$platform.txt") || fail 'Missing, duplicate or malformed package checksum.'
    download "$asset"
    if [ "$platform" = mac ]; then
        actual=$(shasum -a 256 "$work/$asset")
    else
        actual=$(sha256sum "$work/$asset")
    fi
    actual=${actual%% *}
    [ "$actual" = "$expected" ] || fail 'Checksum mismatch. Nothing was installed.'
    app_closed
    printf 'Jenny: checksum verified. Installing...\n'

    # Only the named app is replaced. Backups remain beside it until commit.
    replace_app() {
        safe_path "$target"
        replacing=1
        if [ -e "$target" ]; then
            backup=$stage/previous
            mv "$target" "$backup"
        fi
        mv "$stage/new" "$target" || fail 'Replacement failed; restoring the previous app.'
        replacing=0
    }
    launch_linux() {
        if command -v nohup >/dev/null 2>&1; then
            nohup "$1" >/dev/null 2>&1 &
        else
            "$1" >/dev/null 2>&1 &
        fi
        launch_pid=$!
        sleep 2
        if ! kill -0 "$launch_pid" 2>/dev/null; then
            wait "$launch_pid" || fail "Jenny is installed but could not start. Run $1 in a terminal to see missing desktop libraries or AppImage/FUSE requirements."
        fi
    }
    # Owned launchers carry the marker line; never rewrite any other file.
    owned_launcher() { [ -f "$1" ] && grep -q '^# Jenny one-command installer$' "$1"; }
    write_launchers() { # directory, executable
        quoted=$(printf '%s' "$2" | sed "s/'/'\\\\''/g")
        printf '#!/bin/sh\n# Jenny one-command installer\nexec '\''%s'\'' "$@"\n' "$quoted" > "$1/launcher"
        chmod 755 "$1/launcher"
        escaped=$(printf '%s' "$2" | sed 's/\\/\\\\\\\\/g; s/"/\\\\"/g; s/`/\\\\`/g; s/\$/\\\\$/g; s/%/%%/g')
        printf '# Jenny one-command installer\n[Desktop Entry]\nType=Application\nName=Jenny\nExec="%s" %%U\nTerminal=false\nIcon=jenny\nStartupWMClass=jenny\nCategories=Development;\n' "$escaped" > "$1/desktop"
        chmod 644 "$1/desktop"
    }
    case "$kind" in
        deb)
            # Let apt's sandboxed reader traverse just this temporary download.
            chmod 755 "$work"
            chmod 644 "$work/$asset"
            if [ -r /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
                sudo apt-get install -y "$work/$asset" </dev/tty || fail 'apt installation failed. Resolve the reported package error and retry.'
            else
                sudo -n apt-get install -y "$work/$asset" || fail 'Open a desktop terminal so sudo can request your password, then retry.'
            fi
            packaged=/opt/Jenny/jenny
            # A previous AppImage install's launchers would otherwise shadow the package.
            write_launchers "$work" "$packaged"
            if owned_launcher "$bindir/jenny"; then
                safe_path "$bindir/jenny"
                mv "$work/launcher" "$bindir/jenny" || fail 'Jenny is installed, but the old launcher could not be updated.'
            fi
            if owned_launcher "$desktopdir/jenny.desktop"; then
                safe_path "$desktopdir/jenny.desktop"
                mv "$work/desktop" "$desktopdir/jenny.desktop" || fail 'Jenny is installed, but the old desktop entry could not be updated.'
            fi
            launch_linux "$packaged"
            ;;
        appimage)
            appdir=$user_home/.local/share/jenny/app
            for path in "$appdir" "$bindir" "$desktopdir"; do safe_path "$path"; mkdir -p "$path"; done
            target=$appdir/Jenny.AppImage
            safe_path "$target"
            [ ! -e "$target" ] || [ -f "$target" ] || fail "Existing $target is not a regular file. Move it aside and retry; nothing was changed."
            safe_path "$bindir/jenny"
            safe_path "$desktopdir/jenny.desktop"
            # Do not overwrite a launcher owned by a different installation.
            for path in "$bindir/jenny" "$desktopdir/jenny.desktop"; do
                if [ -e "$path" ] && ! owned_launcher "$path"; then
                    fail "Existing launcher is not owned by this installer: $path"
                fi
            done
            stage=$(mktemp -d "$appdir/.stage.XXXXXXXX")
            cp "$work/$asset" "$stage/new"
            chmod 755 "$stage/new"
            write_launchers "$stage" "$target"
            mv "$stage/launcher" "$bindir/jenny" || fail 'Could not publish the Jenny launcher; the app was not replaced.'
            mv "$stage/desktop" "$desktopdir/jenny.desktop" || fail 'Could not publish the Jenny desktop entry; the app was not replaced.'
            replace_app
            launch_linux "$target"
            ;;
        mac)
            system_app=/Applications/Jenny.app
            personal_app=$user_home/Applications/Jenny.app
            safe_path "$system_app"
            safe_path "$personal_app"
            if [ -e "$system_app" ] && [ -e "$personal_app" ]; then
                fail 'Jenny exists in both /Applications and ~/Applications. Keep one installation and retry.'
            elif [ -e "$system_app" ]; then target=$system_app
            elif [ -e "$personal_app" ]; then target=$personal_app
            elif [ -w /Applications ]; then target=$system_app
            else target=$personal_app
            fi
            parent=$(dirname "$target")
            mkdir -p "$parent"
            [ -w "$parent" ] || fail "Cannot update $target as this user. Use the DMG manually."
            stage=$(mktemp -d "$parent/.jenny-stage.XXXXXXXX")
            mkdir "$work/mount"
            hdiutil attach "$work/$asset" -readonly -nobrowse -mountpoint "$work/mount" >/dev/null || fail 'Could not attach the Jenny disk image. Nothing was installed.'
            mount=$work/mount
            [ -d "$mount/Jenny.app" ] && [ ! -L "$mount/Jenny.app" ] || fail 'DMG is missing Jenny.app.'
            ditto "$mount/Jenny.app" "$stage/new"
            # curl does not add browser quarantine. Preserve normal Gatekeeper review.
            xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");JennyInstaller;" "$stage/new"
            hdiutil detach "$mount" >/dev/null
            mount=
            replace_app
            printf 'Jenny: macOS may require Privacy & Security > Open Anyway for this unsigned experimental build.\n'
            open "$target" || fail "Installed at $target; open it in Finder and complete the macOS security prompt."
            ;;
    esac
    printf 'Jenny: installed %s. Opening Jenny; complete any OS security prompt, then choose your workspace and model in onboarding.\n' "$tag"
)
install_jenny
