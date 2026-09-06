# Skills and Personality

Skills give Jenny reusable, named instruction blocks. Each skill is a `SKILL.md`
file in its own directory. Jenny can advertise the skill to the model, load it on
demand, or attach it to one turn through an optional `/command`.

```text
my-skill/
└── SKILL.md
```

## `SKILL.md` frontmatter reference

A skill may start with YAML frontmatter followed by its instruction body:

```markdown
---
name: My Skill
description: Do one specific kind of work.
---
Instructions for Jenny go here.
```

The opening delimiter must be the first line and the closing delimiter must be
on its own line. Jenny normalizes CRLF line endings before Electron-side metadata
discovery. The sidecar recognizes a frontmatter block only when the normalized
file starts with `---\n` and contains a later `\n---\n`.

None of the accepted keys is required.

| Key | Type | Required | Default | Accepted aliases | Validation and normalization |
|---|---|---:|---|---|---|
| `name` | String | No | `Unnamed Skill` in the sidecar | None | A non-empty string is trimmed. Other values leave the default in place. Electron's metadata view uses the containing directory name when this value is absent. |
| `description` | String | No | Empty string | None | A string is trimmed. Other values leave the default in place. |
| `command` | String | No | Containing directory name, lowercased, with `_` replaced by `-` | None | Python applies `re.fullmatch(r"[a-z][a-z0-9-]{0,31}", command)`. An explicit value is trimmed and lowercased. A valid explicit value replaces the derived default; an invalid explicit value is ignored, so the valid derived default remains. If the derived default is invalid, the command is empty. |
| `whenToUse` | String | No | Empty string | `when_to_use`, `when-to-use` | Jenny takes the first truthy value in canonical-then-alias order. A string is trimmed; other values produce an empty string. |
| `allowedTools` | String or list | No | Empty list | `allowed_tools`, `allowed-tools` | A non-empty scalar string becomes one item. A list keeps string, integer, and float items that normalize to non-empty names; other items are dropped. `bash`, `glob`, and `grep` normalize to `run_command`, `glob_files`, and `grep_search`. When runtime tool status is available, unavailable names are omitted from the rendered skill summary. |
| `metadata.jenny.always` | Boolean-like scalar | No | `false` | `metadata.nanobot.always` | This key must be nested under `metadata.jenny`; `metadata.nanobot` is the compatibility alias. Boolean `true`, or a value whose trimmed lowercase text is `1`, `true`, `yes`, or `on`, becomes true. Other values become false. If `metadata.jenny` exists, it is considered before the `nanobot` alias. |

Unknown keys are ignored by the runtime parser.

The command grammar allows 1 to 32 characters. It starts with a lowercase ASCII
letter and continues with lowercase ASCII letters, digits, or hyphens. Although
the general slash-command registry accepts underscores, a skill command does not:
the skill parser's pattern is `[a-z][a-z0-9-]{0,31}` under `re.fullmatch`.

YAML anchors and aliases are rejected before the YAML document is loaded. Both
produce error code `CMP-CTX-0001` and this message:

```text
skill frontmatter aliases are not allowed in '<path>'
```

### Complete example

This example uses every canonical frontmatter key:

```markdown
---
name: Verification Specialist
description: Check a proposed change against its stated acceptance criteria.
command: verify
whenToUse: Use when the user asks to verify a change or investigate a failed check.
allowedTools:
  - read_file
  - grep_search
metadata:
  jenny:
    always: false
---
Verify the requested behavior against current source and focused checks.

Report:
- the result;
- the evidence used;
- anything that could not be checked.
```

For a smaller real example, inspect the bundled
`skills/claude_code_delegation/SKILL.md`. It defines the `/handoff` command and
keeps the body focused on one reusable workflow.

## Scopes: bundled, user, and project

Jenny resolves configured skill scopes in this order:

1. `bundled`
2. `user`
3. `project`

| Scope | Application root | Runtime config key | Enable flag | Intended use |
|---|---|---|---|---|
| Bundled | The app-shipped `skills/` directory | `skills_bundled_root` | `skills_bundled_enabled` | Skills that ship with Jenny. The repository currently contains six. |
| User | `~/.companion/skills` | `skills_user_root` | `skills_user_enabled` | Personal skills available independently of the selected tools workspace. |
| Project | `<tools workspace root>/.jenny/skills` | `skills_project_root` | `skills_project_enabled` | Instructions specific to the selected project. A tools workspace root must be set before this scope has a root. |

The sidecar configuration model defaults all three `*_enabled` flags to `true`.
The desktop application's saved settings default bundled skills on and user and
project skills off, so you opt in before personal or project instructions are
exposed through the normal UI.

A null root is not synthesized by the sidecar. `_resolve_skill_scopes` simply
omits that scope. An existing scope is also skipped when its enable flag is not
true or its root does not exist.

### What happens when scopes overlap

Discovery does not deduplicate by skill name, command, directory slug, or file
contents. It deduplicates by the `SKILL.md` file's filesystem identity: inode and
device where an inode is available, otherwise its resolved path.

This produces two different cases:

- If two scope roots reach the same physical `SKILL.md`, only the first encounter
  is kept. Scope traversal is bundled, then user, then project.
- If separate files use the same directory slug, both remain in the catalog with
  distinct IDs such as `bundled/check` and `project/check`.

The scope-qualified ID is the normal way to keep those separate. When the model
calls `load_skill` without a scope, that builtin tries bundled, user, and project
in order and returns the first matching slug. Supplying `scope` removes the
ambiguity.

Slash commands have a separate collision rule described under
[Troubleshooting](#command-missing-or-colliding).

## Limits

Skill discovery and prompt assembly are bounded. The relevant sidecar constants
are:

| Constant | Value | What it bounds |
|---|---:|---|
| `MAX_SKILL_FILE_BYTES` | 15,360 bytes (`15 * 1024`) | One complete `SKILL.md` read. The indexed loader refuses an oversized file; the `load_skill` tool uses the same byte cap and can return a truncated body. |
| `MAX_SKILL_FRONTMATTER_BYTES` | 16,384 bytes (`16 * 1024`) | The encoded YAML frontmatter block before parsing. The whole-file limit is smaller and is encountered first during normal indexed discovery. |
| `MAX_SKILL_FRONTMATTER_TOKENS` | 256 | Tokens emitted by the YAML scanner for one frontmatter block. This is a YAML structure budget, not a model-token estimate. |
| `MAX_SKILL_PROMPT_BYTES` | 65,536 bytes (`64 * 1024`) | The rendered aggregate skills overlay. Excess guidance is clipped with `[additional skills omitted: prompt budget reached]`. |
| `MAX_SKILL_FILES` | 128 | Skill files across all enabled scopes in one sidecar catalog load. Remaining capacity is passed to each scope in resolution order. |
| `MAX_SKILL_DISCOVERY_ENTRIES` | 2,048 | Filesystem entries inspected during one scope discovery. |
| `MAX_SKILL_DEPTH` | 8 | Recursive directory depth below a scope root. |
| `MAX_SKILL_DISCOVERY_SECONDS` | 0.5 seconds | Wall-clock discovery time for one scope scan. |

These limits keep initialization predictable. Skill discovery is on a path that
the sidecar blocks on during `initialize`; frontmatter also imports the YAML
parser lazily so skills without frontmatter do not pay that import cost.

When a discovery bound is reached, Jenny keeps the files found so far and emits
`ai.context.skill_discovery_partial`. Its reason identifies the bound, including
`aggregate_file_budget`, `entry_budget`, `depth_budget`, or `time_budget`.

## Using a skill

You can bring a skill into a turn in three ways.

### 1. Attach `/command` in the composer

Type `/` as the first composer token. Autocomplete separates skills from ordinary
commands, searches the command, skill name, and description, and shows up to eight
rows. Choose a skill with Tab, Enter, or the pointer.

Running a skill command is an attach action. Jenny removes the `/command` token,
leaves any following text as the prompt, and shows a removable skill chip in the
composer. For example:

```text
/verify check the current diff
```

attaches `verify` and sends `check the current diff`.

An attached skill belongs to the session that attached it. Switching sessions
drops the pending attachment. It applies to one accepted turn: after the send
returns a `streamId`, the pending attachment and chip are cleared. Queued sends
capture their own attachment so a later composer selection cannot replace it.

The sidecar inserts the selected body as a request-time system message headed
`## Invoked Skill: <name>`. This direct route is independent of whether the
automatic skill index is visible for the current engine.

### 2. Attach from the command palette

Open the command palette with Ctrl+K or Command+K. Enabled skill slash entries
appear in the `Skills` group with an `Attach` hint. Selecting one executes the
same slash attach action and produces the same composer chip and one-turn scope.

The palette snapshots its providers once each time it opens. If you add or edit a
skill while the palette is already open, close and reopen it after Jenny's skill
state refreshes.

### 3. Let the model call `load_skill`

The read-only `load_skill` builtin lets the model fetch a discovered skill body
mid-turn. It takes:

- `name`: the relative skill directory slug shown in the `Available Skills`
  index, including nested segments when present;
- `scope`: optional `bundled`, `user`, or `project`.

The tool reads only from configured skill roots, not from an arbitrary path or
the tools workspace. It is gated by `tools_load_skill_enabled`, which defaults to
true. See [Built-in Tools Reference](TOOLS.md#skills) for the tool-facing summary.

If `scope` is omitted, resolution tries bundled, user, then project. An invalid
name or scope is rejected with `CMP-TOOL-0004`. A valid request that does not
resolve returns `CMP-TOOL-0040` and a bounded list of available scope/name pairs.

### Automatic indexing

`skills_auto_index` accepts exactly `auto`, `on`, or `off`. Any other runtime
configuration value normalizes to `auto`.

| Value | Behavior |
|---|---|
| `auto` | Suppress the automatic skills overlay for `ollama`, `vllm`, and `openai-compatible`; render it for other engine types. |
| `on` | Render the automatic skills overlay for every engine type. |
| `off` | Do not render the automatic skills overlay. |

The overlay inlines the body of skills whose nested `always` value is true. Other
skills are listed by name, scope, description, usage hint, and available tool
metadata so the model can call `load_skill`. Legacy `workspace`-scoped skills are
also inlined because `load_skill` has no `workspace` scope.

`skills_disabled_ids` disables individual entries. IDs use the form
`<scope>/<relative-directory>`, for example `project/review/security`. A disabled
ID is removed from both inline and indexed prompt guidance, is not registered as
a slash skill, and cannot be loaded through `load_skill`.

## Personality customization

Jenny's current personality workspace is:

```text
%APPDATA%\jenny\personality\default-workspace\
├── PERSONALITY.md
├── USER.md
├── MEMORY.md
├── .personality-state.json
└── legacy\                 # present after a migration archives old material
```

The three user-owned Markdown files are the only active compiled inputs:

| File | Compiled section | Purpose | Character budget |
|---|---|---|---:|
| `PERSONALITY.md` | `### Voice` | How Jenny should sound and behave | 1,500 |
| `USER.md` | `### About the user` | Your name, work, and collaboration preferences | 1,000 |
| `MEMORY.md` | `### Notes` | Durable facts and preferences sent as long-term notes | 1,500 |

`.personality-state.json` records the workspace schema version and migration
results. It is app-owned state, not prompt content. `legacy/` is an archive made
by the v3 migration and is never read by the compiler. A retired `memory/`
directory may be encountered during an upgrade, but v3 moves its contents to
`legacy/memory/` and removes it; daily memory files are not active inputs.

Each active Markdown file has a 64 KiB read and write limit. After headings,
frontmatter, HTML comments, and surrounding whitespace are normalized away, the
three sections use the character budgets above. The joined sections then have a
shared 4 KiB UTF-8 byte backstop. Clipping uses a trailing ` […]` marker and
reserves room for every participating section heading.

Use Settings to edit these files, or use **Open folder** to work on them directly.
The app seeds missing files with commented placeholders; unchanged placeholders
compile to nothing. The full walkthrough is [Personality customization](tutorials/03-personality-customization.md).

### How personality reaches the prompt

The base system prompt establishes Jenny's task behavior. The prompt builder then
layers current date, executable-tool guidance, optional skill guidance, workspace
instructions, and other enabled runtime context around that base. Electron
compiles the three personality files into `### Voice`, `### About the user`, and
`### Notes` sections. The sidecar sanitizes that content and adds the single
`## Personality` heading plus the assistant-name and precedence sentence.

The personality block is one request-time system message on a non-minimal turn.
Its own precedence sentence states that personality shapes tone, while the
current request and runtime, workspace, and tool instructions take precedence.
Invoked skills and any automatic skills overlay are separate request-time system
guidance; they do not rewrite the cache-stable base prompt.

## Troubleshooting

### Skill does not appear

Check these causes in order:

1. The configured `skills_<scope>_root` is null, missing, not a directory, or
   cannot be resolved safely. The sidecar omits a null root. Project skills also
   need an explicit tools workspace root.
2. The matching `skills_<scope>_enabled` flag is false. In the desktop defaults,
   user and project scopes are off until you enable them.
3. The skill ID appears in `skills_disabled_ids`.
4. The file is not named exactly `SKILL.md`, is below a skipped link or reparse
   point, or lies beyond the depth budget.
5. Discovery reached its aggregate file, entry, depth, or time budget before it
   reached the file. Look for `ai.context.skill_discovery_partial` and its
   `reason` field.
6. The file is not regular UTF-8 text, resolves outside its configured root, or
   exceeds `MAX_SKILL_FILE_BYTES`. Non-strict loading logs
   `ai.context.skill_skipped` and continues with other skills.
7. `skills_auto_index` is `off`, or it is `auto` with a local inference engine.
   This hides automatic model guidance but does not prevent an enabled slash
   command from attaching a skill directly.

### Command missing or colliding

The skill command must match `[a-z][a-z0-9-]{0,31}` under `re.fullmatch`. If an
explicit `command` is invalid, Electron logs `skills.invalid_command` and uses a
valid command derived from the directory name. Its warning text is:

```text
Invalid skill command; using '<derived-command>' from the directory name.
```

If both the explicit and derived values are invalid, the command is empty and no
slash entry is registered.

The built-ins `help`, `context`, `compact`, and `note` reserve their command
names. A skill that collides with one is skipped. When enabled skills share a
command, the first entry encountered is retained and later entries are skipped.
The snapshot is traversed by scope in bundled, user, project order; entries
within each scope are path-sorted by the Electron skill service.

Each collision logs `slash.skill_command_collision` at `WARN` with `command`,
`firstId`, and `secondId`. A built-in winner is identified as, for example,
`builtin/help`.

### Frontmatter is refused

All sidecar frontmatter failures below use `CMP-CTX-0001`:

```text
skill frontmatter exceeds byte budget in '<path>'
skill frontmatter exceeds structure budget in '<path>'
skill frontmatter aliases are not allowed in '<path>'
invalid YAML frontmatter in '<path>': <parser error>
invalid YAML frontmatter in '<path>': expected an object
```

Electron metadata discovery has an additional delimiter check. An opening
delimiter without a closing delimiter produces warning code `skill_parse_failed`
and the exact message:

```text
Skill frontmatter is missing a closing delimiter.
```

The sidecar splitter itself treats an unclosed delimiter as ordinary body text,
so this refusal is the Electron catalog's metadata-validation behavior.

### Skill body is truncated or skipped

`load_skill` reads with truncation enabled. If the complete file is larger than
15,360 bytes, its result ends with:

```text
[skill content truncated at 15360 bytes]
```

The context builder's catalog load is stricter: it reads with truncation disabled,
so an oversized `SKILL.md` is skipped instead of partially indexed. In strict
loading, the wrapped `CMP-CTX-0001` message is:

```text
failed to load skill file '<path>': file_budget_exceeded
```

Keep the complete file, including frontmatter, within 15,360 UTF-8 bytes if you
want identical behavior across automatic indexing, slash attachment, and
`load_skill`.
