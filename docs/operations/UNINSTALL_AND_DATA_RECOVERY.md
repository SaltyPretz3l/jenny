# Uninstall and Data Recovery

Jenny uses one data-lifecycle service for Settings, the dedicated uninstall
assistant, platform helpers, and first-launch restore. Removal is allowlist
driven: unknown files, shared models, and ordinary workspace files are retained.

## User choices

- **Keep a recoverable archive** (recommended) creates and reads back a complete
  archive before any live Jenny data is removed. An archive failure can never
  authorize cleanup.
- **Remove app only** removes application files while leaving the profile and
  runtime data in place for automatic reuse after reinstall.
- **Permanently remove everything** requires the exact phrase `REMOVE JENNY`
  and removes only known Jenny-owned paths. Workspace `.jenny` data is a
  separate, default-off choice.

Silent Windows uninstall always means app-only. Dragging the macOS app to Trash
also removes only the app. Clone dependency cleanup and clone deletion are
separate prompts; deleting a clone additionally requires a clean Git worktree
and the exact directory name.

## Entry points

- Settings -> Data & Privacy: create or restore archives and
  open the platform's supported removal entry point. On Windows this opens
  Installed apps; on macOS it identifies the signed disk-image helper; clones
  use `npm run uninstall`.
- Windows installed build: Apps & features launches the NSIS-assisted flow.
- macOS DMG: run `Uninstall Jenny.command`; dragging the app to Trash preserves
  data.
- Clone: run `npm run uninstall`, `./uninstall.sh`, `./uninstall.command`, or
  `./uninstall.ps1` as appropriate.

## Archive v1

The default folder is `Documents/Jenny Archives/`. Each archive is a directory
named `Jenny Archive <UTC timestamp>.jenny-archive`. Creation occurs in a
sibling `.partial` directory; `COMPLETE` is written last, every entry is read
back, and only then is the directory renamed to its final name.

Encrypted archives are the default. `archive.json` contains only bounded format,
version, encryption, timestamp, and aggregate-count metadata. The manifest and
all entry names are authenticated and encrypted with AES-256-GCM. The passphrase
uses the fixed, allowlisted `scrypt-v1` profile (`N=131072`, `r=8`, `p=1`,
32-byte key, 256 MiB maximum memory); Jenny never stores or logs it. Plain mode
is available only under Advanced and requires choosing the informed,
warning-labelled action.

Archive v1 includes canonical chats and managed media, an allowlisted portable
preference projection, personality, memory, reminders/calendar, app-owned user
content, and selected compatible workspace `.jenny` data. It excludes secrets,
credentials, logs, caches, process state, Ollama/shared models, image-generation
weights and environments, external knowledge, plugin/MCP/skill executables,
schedules, and ordinary project files. Workspace inclusion defaults off. If
enabled in either Settings or the uninstall assistant, Jenny first shows the
bounded current-workspace identity, allowlisted `.jenny` scope, item count, and
bytes; creation requires approving that exact one-time review. Root identity
and content hashes are revalidated, and later source drift aborts and removes
partial output before a completed archive is published.

The standalone local-image-generation plugin keeps its approximately 40 GB
runtime at `~/.companion/image-gen` outside archive and uninstall cleanup by
default. Plugin uninstall removes the package and its settings but preserves
that runtime and all generated attachments. To delete the runtime, use the
plugin workspace's explicit **Remove downloaded runtime** action; it shows the
measured bytes, requires confirmation, refuses while another operation is
active, terminates the supervised host first, and retains retryable
pending-removal state when Windows locks a file.

## Restore behavior

A meaningfully fresh profile scans only the default archive directory,
non-recursively, and considers at most 50 entries. Jenny offers the newest
compatible complete archive. Choosing **Not now** suppresses only that archive
fingerprint; a newer archive is still offered, and Settings always supports a
manual choice.

Profile restore validates schema/KDF bounds, file and byte caps, authentication and
hashes, traversal, Windows device names and ADS, Unicode/case collisions, and
symlink/junction escape before mutation. Data is extracted into a sibling
staging directory and promoted before canonical stores open on restart. A
rollback copy remains until the next successful boot. Full restore never merges
into a populated profile; use the existing per-session importer for that case.
Workspace entries in the same archive are verified but ignored by profile
restore, so profile recovery can never imply project mutation.

Workspace restore is a separate Data & Privacy action and does not require a
fresh Jenny profile. It targets only the configured workspace's allowlisted
portable `.jenny` paths. Jenny shows the bounded target identity, item and byte
counts, and existing-file conflicts before approval; a one-time review is then
revalidated for archive fingerprint, workspace identity, real-path containment,
and conflict drift after extraction and again per target. Before plaintext is
extracted, Jenny writes and flushes a bounded recovery journal under the
dedicated `.jenny/.restore-staging` owner directory. Existing targets remain
live while verified rollback copies are created and flushed; each same-volume
replacement is flushed before its completion journal advances. A failure
restores prior targets or reports an
incomplete rollback instead of claiming success; startup recovery replays any
interrupted journal before later workspace lifecycle work.

## Ownership boundaries

Known profile data is rooted at `%APPDATA%\jenny` on Windows,
`~/Library/Application Support/jenny` on macOS, and `$XDG_CONFIG_HOME/jenny`
(or `~/.config/jenny`) on Linux. Known runtime data is beneath `~/.companion`.
The cleanup service revalidates each target immediately before mutation,
refuses links/reparse traversal, is safe to retry, and reports per-target
receipts. Profile and runtime cleanup use exact child-name allowlists. Unknown
profile children and unknown `.companion` children are retained and reported;
`models` and `python-runtime` are intentionally outside those allowlists.
`image-gen` is also retained unless the plugin's explicit runtime-removal action
owns the deletion.

Archives are never cleanup targets. Shared Ollama models, package-manager data,
global Node/Python installations, external knowledge folders, and project files
outside an explicitly selected workspace `.jenny` folder are never removed.

## Failure recovery

- An incomplete `.partial` archive is not a restore candidate and may be removed
  after confirming no Jenny archive operation is running.
- `CMP-DATA-0006` means the passphrase is wrong or authentication failed.
- `CMP-DATA-0007` means the archive is corrupt, incomplete, or violates bounds.
- `CMP-DATA-0009` means the profile is no longer fresh; import individual
  sessions instead.
- `CMP-DATA-0010` means cleanup was incomplete. Review the receipt and retry;
  Jenny never reports full removal while selected owned targets remain.

Do not edit files inside an archive. Keep at least one independent copy before
permanently removing live data. Close every running Jenny instance before using
the terminal clone flow so it cannot race a live profile writer.
