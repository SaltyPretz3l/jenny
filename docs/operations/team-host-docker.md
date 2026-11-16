# Team host in Docker (headless Linux)

A Jenny team host with no desktop: one container on a Linux x64 machine that
holds the team's members, project conversations and project folders. Members
connect from their own Jenny through the team bridge on one UDP port. This is
slice 3-11 of the team program (`docs/plans/TEAM_PROJECTS_SPEC.md`, "3-11 as
built"); the rules it follows are in `AGENTS.md`, "Approved team hosting
boundary".

Files: `Dockerfile.team`, `compose.team.yml`, `config/team-host.example.json`.
The single-owner hosted image (`Dockerfile`, `compose.host.yml`) is separate
and unchanged.

What the container does and does not do:

- Nothing listens on TCP outside the container. The application listener is on
  loopback inside it and answers only connections that carry the per-run boot
  secret, which only the bridge has. Members reach it through the bridge on the
  UDP port.
- No environment variable, argument or config field carries a key, token or
  secret. The host key is a file in the secrets volume, written once by
  `team-keygen`.
- The host has no model. A headless host is a no-model host unless its owner
  adds a `pool` block to `team-host.json` by hand.
- The image has no command sandbox, no Rust toolchain and no Docker socket.

## 1. Build the bridge (Linux x64)

The image copies a prebuilt `build/sidecar/jenny-team-bridge`; it does not build
it. Build it on a Linux x64 machine with Python 3 and Rust 1.91 or newer:

```bash
npm run build:team-bridge
```

Release builds use Ubuntu 22.04, so the binary runs on glibc 2.35 and newer
(`docs/BUILDING.md`, "Team bridge"); the image is Debian bookworm (glibc 2.36).
Build on Ubuntu 22.04, or in an `ubuntu:22.04` container, to keep that floor.
A Windows or macOS build (`jenny-team-bridge.exe`, a Mach-O file) does not work
in the image. Without the file the image build stops at the
`COPY ... build/sidecar/jenny-team-bridge` step and names it. With a file that
cannot run there, it stops at the `--version` check.

## 2. Write the config

```bash
mkdir team-config
cp config/team-host.example.json team-config/team-host.json
chmod 755 team-config && chmod 644 team-config/team-host.json
```

Create the setup service's two folders now, before step 4. The setup service
bind-mounts them from its first run, and Docker would create missing ones owned
by root, which the commands (uid 10001) cannot use:

```bash
mkdir -m 0700 team-import team-exchange
```

```bash
sudo chown 10001:10001 team-import team-exchange
```

Edit `team-config/team-host.json`:

- `team.name`: the team's name, as members see it.
- `team.direct_port`: the bridge's UDP port. Keep it equal to the port in
  `compose.team.yml` (`"41700:41700/udp"`). If you change one, change both.
- The paths (`/data`, `/run/jenny-secrets`, `/srv/jenny-team/projects`) are
  inside the container. Leave them as they are.
- Optional: so that invites name this machine, add
  `"internet": { "map_port": false, "public_address": "<this machine's name or address>", "relay_url": null }`
  to the `team` block. In a container the host sees only its own container
  addresses, not the machine's. `team-init` runs with no network at all, so
  without `public_address` its invite has no address hints. Give the joiner the
  machine's address another way. Leave `relay_url` as null: see "What is not
  here".

The file holds no secret.

## 3. Build the image

```bash
docker compose -f compose.team.yml config --quiet
```

```bash
docker compose -f compose.team.yml build
```

(The same image by hand:
`docker build --platform linux/amd64 -f Dockerfile.team -t jenny-team-host:local .`)

## 4. Create the host key and the first owner invite

Run these with the team service stopped. Both use the `setup` service. It is
the same image with the secrets volume writable, no network and **no logs**
(`logging: none`).

```bash
docker compose -f compose.team.yml --profile setup run --rm -it setup node server/cli.js team-keygen --config /etc/jenny/team-host.json
```

This writes the host key file once (mode 0600) and prints only the team id. A
second run refuses and leaves the existing key as it is.

```bash
docker compose -f compose.team.yml --profile setup run --rm -it setup node server/cli.js team-init --config /etc/jenny/team-host.json
```

The first owner invite appears once, on that terminal, and nowhere else. The
setup service writes no container log, so `docker logs` never holds it, and
`team-init` refuses to print without a terminal (`-it`). Do not redirect it to a
file. It expires within 15 minutes, so run it when you are ready to redeem it in
your own Jenny at once. `team-recover` (the same form) prints an owner recovery
invite the same way.

## 5. Start and check

```bash
docker compose -f compose.team.yml up -d team
```

```bash
docker compose -f compose.team.yml ps
```

The health check is `node server/healthcheck.js --config /etc/jenny/team-host.json --ready`.
It makes no network request. The host is healthy while the ready marker in its
profile (`team-ready.json`) names this run's process. On Linux the marker also
records the process's start time, so a marker left by a killed container reads
as not ready after a restart, although the new host is pid 1 again. Docker
restart policies act on exit, not on health.

To check the parts one by one, run `team-doctor` (it only reads):

```bash
docker compose -f compose.team.yml exec team node server/cli.js team-doctor --config /etc/jenny/team-host.json
```

It reports the key file, the projects root, the bridge and readiness. It never
shows a path, the key or an invite. The Docker setup doctor (`docker-setup.*`,
`server/setup.js doctor`) is for the single-owner host and does not understand
a team config.

Logs (`docker compose -f compose.team.yml logs team`) carry event names,
reasons, ids and counts only. A start that fails logs `team.start_failed` with
its reason, for example `team_host_key_invalid` (no key file: run step 4) or
`team_projects_root_missing` (no `projects/` folder in the data volume).

## Where the data lives

| Volume | Mounted at | Holds |
|---|---|---|
| `jenny_team_profile` | `/data` | members, invites, project conversations, team chat, audit logs, the ready marker |
| `jenny_team_data` | `/srv/jenny-team` | `projects/` (one folder per shared project) and `trash/` beside it |
| `jenny_team_secrets` | `/run/jenny-secrets` (read-only for the server) | `team-host-key` |
| `./team-config` | `/etc/jenny` (read-only) | `team-host.json` |

`projects/` and `trash/` must be on one filesystem: moving a project to the
trash is a rename, and a rename across filesystems is refused. Keep them on the
one data volume. The image creates `projects/` in a new named volume. If you
replace the volume with a bind mount, create `projects/` in it yourself, owned
by uid 10001. The host creates `trash/` at start.

## Backup

Stop the team service, then copy the three volumes out through the setup
service (no network, no logs):

```bash
docker compose -f compose.team.yml stop team
```

```bash
docker compose -f compose.team.yml --profile setup run --rm -T setup tar -C / -czf - data srv/jenny-team run/jenny-secrets > jenny-team-backup.tgz
```

The archive holds the host key. Keep it as private as the key itself. To put
it back, extract it into fresh volumes with the team service stopped:

```bash
docker compose -f compose.team.yml --profile setup run --rm -T setup tar -C / -xzf - < jenny-team-backup.tgz
```

The tar archive is a copy of the volumes. The `team-export` command below
writes one password-locked file instead, in the same format as the desktop
app's backup, which restores on either kind of host.

## Maintenance: copy in, export, restore, delete

Four commands run in the `setup` service with the team service **stopped**.
Whoever can run them is the owner, as for `team-init`. Each takes the profile
lock: while the team server runs it holds the lock, and the command refuses with
`team_profile_locked`. Stop the server first:

```bash
docker compose -f compose.team.yml stop team
```

The setup service has two folders the team service never sees, made in step 2
(owned by uid 10001, mode 0700):

| Folder on the machine | In the setup container | Used by |
|---|---|---|
| `./team-import` | `/mnt/jenny-import` (read-only) | `team-copy-in` reads a folder from here |
| `./team-exchange` | `/mnt/jenny-exchange` | `team-export` writes its file here; `team-restore` reads one here |

`team-host.json` names them as `team.import_dir` and `team.exchange_dir`. The
example has the defaults; leave them as they are unless you change the compose
file too. No command takes a path: a folder or file is named by one plain name
directly inside its folder. The commands print status words and counts, never a
path, a file name, the key or a password, and refuse with one reason word.

**Getting files in and out.** Both folders belong to uid 10001 with mode 0700,
and an export is 0600, so your own user cannot read or write them directly. Put
a folder in for `team-copy-in`:

```bash
sudo cp -r <your folder> team-import/ && sudo chown -R 10001:10001 team-import/<your folder>
```

Put a backup in for `team-restore`:

```bash
sudo cp <file>.jennyteam team-exchange/ && sudo chown 10001:10001 team-exchange/<file>.jennyteam
```

Take an export off the machine (then copy it on as you like):

```bash
sudo cp team-exchange/jenny-team-<date and time>.jennyteam ~/ && sudo chown "$USER" ~/jenny-team-<date and time>.jennyteam
```

When the ownership is wrong the commands cannot read what you put there:
`team-copy-in` refuses with `team_copy_in_unreadable` (or
`team_copy_in_source_invalid` when the folder itself cannot be seen) and
`team-restore` with `team_restore_file_invalid`. Fix the owner with the `chown`
above and run the command again.

Refusal words you may see, besides those of a member's upload:

| Word | Means |
|---|---|
| `team_profile_locked` | The team server is running: stop it first |
| `team_delete_unfinished` / `team_restore_unfinished` | A delete or restore was cut part way: run that command again first (`team-keygen`, `team-init`, `team-recover`, `team-copy-in` and `team-export` refuse until it finishes). `team_restore_unfinished` with no team in place also means a cut restore left its unpacked data behind: `team-restore` or `team-delete` clears it |
| `team_delete_failed` / `team_restore_failed` | A team folder could not be listed or removed; nothing was treated as empty and the key is kept: fix the folder's permissions and run the command again |
| `team_delete_marker_left` | The delete could not write its marker and could not remove the partial one: free disk space, then run `team-delete` again |
| `team_backup_too_new` | The backup was made by a newer Jenny: update this host first |
| `team_restore_key_foreign` | A restore was cut and a key file that is not the restored team's was put in place since: remove that key file yourself, then run `team-restore` again |
| `team_projects_root_missing` | The data volume has no `projects/` folder |
| `team_copy_in_too_many` | The folder has more than 50,000 entries (files and folders together) |
| `team_copy_in_empty` | The folder holds no file (empty folders are not carried) |
| `team_copy_in_changed` | A file changed while it was being copied: run it again |
| `team_export_exists` | A file of the export's name is already in the exchange folder |
| `team_disk_full` | Not enough room: an export needs about twice the team's size plus 256 MiB on the exchange folder; a restore the file's size plus 256 MiB on the profile and data volumes |

**Copy a folder into a project.** Put the folder in `./team-import`, then:

```bash
docker compose -f compose.team.yml --profile setup run --rm setup node server/cli.js team-copy-in --project <project id> --folder <folder name> --config /etc/jenny/team-host.json
```

It lands as a new top-level folder of that name in the project, through the same
checks as a member's upload: at most 2,000 files and 512 MiB a copy, 64 MiB a
file, inside the project's 10,000 files and 2 GiB and the 8 GiB over all
projects. These caps, the project and a folder of that name already in the
project (nothing is merged or overwritten) are checked before any file is read.
A symlink or junction anywhere in the folder refuses the whole copy. Empty folders are not carried. The project audit log records the
copy (`files_copied_in`, no member) before any file is copied. Each project's
folder in the data volume is named by its id, so this lists them:

```bash
docker compose -f compose.team.yml --profile setup run --rm setup ls /srv/jenny-team/projects
```

**Export the team to one file.**

```bash
docker compose -f compose.team.yml --profile setup run --rm -it setup node server/cli.js team-export --config /etc/jenny/team-host.json
```

It asks for a password twice (10 characters or more, not shown) and writes
`jenny-team-<UTC date and time>.jennyteam` into `./team-exchange`, mode 0600.
The file holds the host key, the members, the conversations, the projects, the
trash and the audit logs, locked by the password. Keep both safe. It needs a
terminal (`-it`) and refuses without one. The team name in the file is the one
the members see (a rename in the app wins over `team.name`). A run that was
killed part way can leave a hidden `.jenny-team-...partial` file; the next
export removes it.

**Restore a team from such a file.** Only onto a host with no team at all (no
key file, no member store, no project folder, an empty trash): restore never
overwrites a team. Put the file in `./team-exchange`, then:

```bash
docker compose -f compose.team.yml --profile setup run --rm -it setup node server/cli.js team-restore --file <file name> --config /etc/jenny/team-host.json
```

A desktop app's backup (`.jennyteam`) works the same way. A wrong password or a
damaged file writes nothing. The host key file is written last. If a restore is
cut part way, run the same command again: it clears what the cut run left and
restores again (or, when only the last step was cut, finishes it). Internet
joining and any relay come from `team-host.json`, not from the backup: a desktop
backup's relay token and internet setting are checked and dropped. Project folders recorded at
another machine's path are pointed at this host's projects folder. Then, if the
owner's Jenny is on a new device, run `team-recover` (step 4) and start the
server.

**Delete the team.**

```bash
docker compose -f compose.team.yml --profile setup run --rm -it setup node server/cli.js team-delete --config /etc/jenny/team-host.json
```

It asks you to type the team's name exactly. It removes every project folder,
the trash, the members, conversations, chat and audit logs, then the host key
file last. It keeps the volumes, the empty `projects/` folder, the profile's lock
and owner files, and `team-host.json`. If a delete is cut part way, run it again
(it asks for the same name, kept in the marker `.jenny-team-deleting` in the
profile, which tells it to finish). Members are not told: the server is stopped, so their Jenny shows the
team as unreachable rather than deleted. To drop the volumes themselves, use
`docker compose -f compose.team.yml down -v` instead.

## What is not here

| Missing | Repaid by |
|---|---|
| Members are told nothing when a headless team is deleted (the server is stopped) | Unassigned |
| Maintenance against a running team server (all four commands need it stopped) | Unassigned |
| A relay token source for a secret-file host: `relay_url` cannot be used headless | Unassigned |
| The POSIX-only file cases (no-follow opens, hard links, directory sync on ext4, key file 0600 and link refusal, the `team-init` lock) have never run on Linux | The owner's first Linux run (the gates below) |
| An arm64 or multi-arch image (amd64 only) | Unassigned |
| Guided setup (`docker-setup.*`) for a team host | Not planned; this guide is the path |

## Owner gates (not run by the slice)

Each needs a Linux x64 machine with Docker:

1. Build the bridge: `npm run build:team-bridge` on Ubuntu 22.04.
2. Check the compose file: `docker compose -f compose.team.yml config --quiet`.
3. Build the image: `docker build --platform linux/amd64 -f Dockerfile.team -t jenny-team-host:local .`
   If the bridge COPY reports the file missing although `build/sidecar/jenny-team-bridge` exists, look
   at `.dockerignore` first: it admits that one file by a negated line under the `*` rule, with no parent
   re-admission of `build/`. BuildKit is expected to honour that; nothing in the slice could prove it.
4. Key and invite: the two `setup` commands in step 4, after the two folders of
   step 2 exist and `ls -ldn team-import team-exchange` shows them owned by
   10001. Check that `docker compose -f compose.team.yml logs` shows no invite.
5. A start that goes healthy: `docker compose -f compose.team.yml up -d team`,
   then `docker compose -f compose.team.yml ps` until `healthy`.
6. A kill and restart that goes unhealthy, then healthy:
   `docker compose -f compose.team.yml kill team`, then
   `docker compose -f compose.team.yml start team`. Watch
   `docker inspect --format '{{.State.Health.Status}}' $(docker compose -f compose.team.yml ps -q team)`.
   The old marker must not read healthy before the new host is ready.
7. A member joins over the UDP port: redeem the step 4 invite from another
   machine's Jenny, then open a shared project.
8. The profile lock excludes the setup service while the team runs. With the
   team service up, run these two commands:
   `docker compose -f compose.team.yml up -d team`, then
   `docker compose -f compose.team.yml --profile setup run --rm -it setup node server/cli.js team-delete --config /etc/jenny/team-host.json`.
   The second must print `team-delete refused: team_profile_locked` before it
   asks anything, and the team must keep running. If it asks for the team name
   instead, the lock did not hold: press Ctrl-C (nothing is deleted) and report
   it.
9. The maintenance round trip: `team-copy-in`, `team-export`, `team-delete`,
   `team-restore` (the commands above), then start the team and check a member
   still joins and sees the copied folder. Repeat the restore with a desktop
   app's `.jennyteam` file.

Known limits of this guide, not verified by the slice: on an SELinux host the
two bind mounts need `:z` (`./team-import:/mnt/jenny-import:ro,z` and
`./team-exchange:/mnt/jenny-exchange:z`); rootless Docker maps uid 10001 to
another uid on the machine and is not supported here; an export needs room for
about twice the team's size plus 256 MiB in `./team-exchange`.
