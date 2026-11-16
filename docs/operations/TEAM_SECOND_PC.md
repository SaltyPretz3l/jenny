---
kind: operations-doc
last_reviewed: 2026-11-15
---

# Team: getting a second PC ready

Before two PCs try a team for the first time, run this on each and fix what it reports:

```
jenny doctor --team
```

It runs the ordinary [`jenny doctor`](JENNY_CLI.md#jenny-doctor) checks, then the team checks
below, then two reminders marked `manual`. It ends with exit code 0 when every check passes. It
takes up to about a minute: 5 seconds for the bridge, up to 30 seconds for the engine, and up to 20
seconds to stop the sidecar again.

It contacts no other PC and changes no firewall or router setting. On a command-line profile that
has been used before, it writes nothing to it, except that starting the sidecar opens the profile's
memory database (`sidecar-memory.db`), which the sidecar may update. On a profile that has never
been used it writes nothing and fails `team_engine_model`, telling you what to run first.

On Windows the command is `%LOCALAPPDATA%\Programs\jenny\resources\bin\jenny.cmd` unless that folder
is on your `Path` (see [Where it is](JENNY_CLI.md#where-it-is)). Each launch of Jenny and each
installer build in this guide is yours to do.

## Turning the Team feature on (Windows)

Team is on by default: Settings > Team is there with nothing to set. It is off only when
`JENNY_ENABLE_TEAM=0` is set, which a PC may still carry from an earlier test. To clear it:

1. In a terminal, run `reg delete HKCU\Environment /v JENNY_ENABLE_TEAM /f`.
2. Quit Jenny completely (including from the tray), then start it again from the Start menu.
3. Open a new terminal before running `jenny doctor --team`.

Jenny 1.7.0 shipped with Team off. A PC on 1.7.0 needs a newer build, or `setx JENNY_ENABLE_TEAM 1`
and a restart.

## team_flag

- **Checks:** the Team feature is on for this command (it fails only when `JENNY_ENABLE_TEAM=0` is set).
- **On FAIL:** follow [Turning the Team feature on](#turning-the-team-feature-on-windows). Restart
  the app too: this check passing does not show that the running app sees the setting.

## team_bridge

- **Checks:** this install has the team bridge, the program that carries team traffic between PCs,
  and that it answers within 5 seconds with the protocol this build expects.
- **On FAIL:**
  - "not found": the installer was built without the bridge. Rebuild it with
    `npm run build:team-bridge` before packaging ([Building](../BUILDING.md)), and reinstall.
  - "speaks protocol": the bridge and the app come from different builds. Reinstall from one
    installer.
  - Anything else: the bridge file is damaged or blocked. Reinstall Jenny. If security software
    quarantined the file, restore it and allow it.

## team_versions

- **Checks:** the protocol number the bridge prints equals the number this build was made for, and
  the app version could be read.
- **On FAIL:** fix `team_bridge` first. If the app version is "unknown", reinstall Jenny.
- **Compare both PCs:** the whole `team_versions` line must be the same on the host and on the
  member PC. If it differs, install the same build on both before going further.

## team_free_disk

- **Checks:** the drive that holds the command-line profile (`%APPDATA%\jenny-cli`) has at least
  20 GiB free. If you keep models on another drive, make sure it has room too.
- **On FAIL:** free space on that drive. "could not be read": check that you can open the profile
  folder.

## team_engine_model

- **Checks:** the local engine the command uses (Ollama unless you set another) answers and has at
  least one model.
- **On FAIL:**
  - "0 models": add a model in that engine (for Ollama, `ollama pull <model>`).
  - "has not been used yet" or "is gone": in your project folder, run `jenny sessions list` once,
    then run this again.
  - "in use by another jenny command": close the other `jenny` command, then run this again.
  - "the sidecar did not start": run plain `jenny doctor` and fix what it reports.
  - "the engine did not answer": start the engine, then run this again.
  - "no answer within 30 s": the first sidecar start on a new PC can take that long, or the engine
    is not answering. Run this again; if it repeats, start the engine.
  - "may still be running": a Jenny sidecar did not confirm it stopped. Find it in Task Manager (by
    the pid shown, when there is one) and end it, then run this again.
  - If you use a different engine in the app, pass `--engine` with that engine.

## Firewall

The first time Jenny hosts or joins a team, Windows may ask whether to allow Jenny on networks.
Allow it on **Private networks** only.

To see the rule later: Settings > Privacy & security > Windows Security > Firewall & network
protection > Allow an app through firewall, then look for Jenny under Private. Your home network
must also be marked private: Settings > Network & internet > Wi-Fi (or Ethernet) > your network >
"Private network". A network marked public blocks the team.

## Port mapping

Only a host taking members over the internet needs port mapping. Two PCs on one Wi-Fi need none,
and a member PC never does. For a host, see the
team internet spec ("Port mapping", "Which networks work without
a relay").

## First run on one Wi-Fi

With both PCs on the same Wi-Fi, every check passing on both, and the same `team_versions` line on
both:

1. **Host PC:** in Jenny, Settings > Team > Host a team: enter a team name and click Deploy.
2. **Host PC:** under "Invite someone", click Create invite and send the code to the member by a
   channel you trust.
3. **Member PC:** Settings > Team > Join a team: paste the invite code and click Join.
4. **Host PC:** the member appears as wanting to join, with the PC's label. Check with the member
   that the label is theirs, then click Admit.
5. **Both PCs:** send one message from the host to the member and one back, and check each arrives.

If the member cannot reach the host, check [Firewall](#firewall) on the host first, then that both
PCs are on the same network and that it is marked private.
