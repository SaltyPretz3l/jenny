# Session runtime operations

The selected program is being implemented incrementally. M1 provides project
authority and migration foundations; durable queueing, Start, children, and
recovery controls are not yet qualified. Follow the active
implementation plan for
milestone status and acceptance evidence.

Shell config v54 stores independent local/cloud runtime defaults. This configuration
foundation does not by itself enable durable dispatch. The default-ON runtime
flag's environment OFF is reserved for safe dispatch pausing; project scope,
sandbox policy, history inspection, and migrations never roll back with it.

## Project authority

Existing sessions belong to General without an inferred folder. General remains
unbound. The Workspace folder is the project: choosing a folder in the Workspace
UI provisions (or finds) the project bound to it, named after the folder, and new
chats start in that project; with no folder configured they start in General.
Existing chats are never retargeted by a folder change. An idle chat whose
project has no folder shows "Use <folder>" above the composer, which assigns
that one chat to the workspace project on click (`projects.adoptWorkspace`).
Runtime & orchestration settings remain the path for several projects, renames,
rebinding and manual assignment. Sessions with no project folder can converse
but cannot use filesystem tools. Hosted profiles never provision implicitly.

Binding a new root invalidates prior authority. Session assignment refuses live
turns, approval/answer waits, deletion, and other in-flight session mutations.
The shared application APIs enforce these checks on desktop and hosted callers;
host roots must additionally remain inside the configured mount. A failed or
future-version store cannot authorize writes.

## Review migrated permissions

Tools settings displays a persistent notice while saved automatic grants await
review. Open Review permissions and inspect each tool's complete match. Choose
the project and folder before allowing an automatic grant. Ask and deny preserve
the corresponding policy; discarding a saved grant never authorizes execution.
Changing the folder or its physical identity invalidates an outstanding review.

Archives keep their existing v1 envelope and cryptography. Versioned project and
permission entries are validated before profile mutation. Import clears project
roots, advances root revisions, and requires grant review. Runtime ledger import
retains operation receipts and pauses unfinished work; it never resumes dispatch.
Corrupt, incomplete, future, or over-capacity ledgers refuse the complete restore.
An authored project registry is not a fresh restore target even without chats.

## Inference admission

Managed Send uses the shared scheduler before dispatch. Local and cloud lanes
retain separate limits, with per-session exclusion across providers. The sidecar
must acknowledge runtime inference admission during initialization, and each
actual provider attempt checks the captured route and authority. Cancellation
requests cleanup; capacity remains held until the producer is confirmed stopped.
Late confirmation can settle the same durable attempt and release its quarantine.

Suggestions, commit messages, and inline completion reserve inference capacity
before creating an auxiliary worker. Manual compaction additionally holds the
session lane and rechecks captured session/project authority before saving its
canonical snapshot. These explicit operations retain admission when the runtime
queue flag is OFF. Unknown cleanup remains charged and inspectable.

## Runtime inspection

The trusted desktop preload bridge exposes read-only `sessionRuntime.getSnapshot`
and `sessionRuntime.getWork`. Both return a closed v1 projection. Inspection works
while dispatch is OFF and never starts or resumes work.

Snapshots accept optional `project_id`, `session_id`, `cursor` and `limit` (1–100)
and page the runtime index without reading work bodies or transcripts. Cursors
bind the index revision and filters; after a stale-cursor error, start a fresh
page. Results show configured limits, downstream ceilings, effective lane limits,
current resource counts and safe work summaries. Limits are ceilings, not promises
of available capacity or provider throughput.

Work detail accepts `work_id`, optional `child_offset` and `lineage_revision`.
It reads one runtime record and at most 50 direct-child summaries. Later child
pages require the captured lineage revision; refresh after a stale projection. It returns
canonical `session_id`/`turn_id` references, attempt correlation and bounded
recovery/control state. `checkpoint.recorded` means a reference was recorded;
it is not proof that the checkpoint can currently resume. Inspection excludes
submitted input, checkpoint bodies, root authority, process handles and raw error
text. Browser transport parity and full program qualification remain pending.

## Desktop orchestration and Send

Runtime & orchestration loads its inspector when opened. Selecting work only
inspects it. Explicit Start captures purpose, instructions and immutable root
inference limits. Work pages expose pause, resume, cancel, direct children,
budget usage and canonical conversation links. Cancel requested and cleanup
confirmed are separate states; outstanding producers keep their capacity.

Configured limits persist with compare-and-swap checks and show their effective
ceilings. Lowering a limit retains existing active or quarantined leases. Sandbox
command capacity remains one. OFF blocks Start and resume while inspection,
cancellation and settings remain available.

New ordinary Send saves work before execution. A saved acknowledgement is not a
stream-start acknowledgement. Multiple pending sends retain their own identity;
canonical admission supplies the actual user-message and attempt IDs before
content. Navigation and renderer disposal do not cancel accepted work. A lost
acknowledgement retries the exact submission; an unresolved outcome is displayed
without launching a second legacy request. Valid images imported in an unsaved
draft bind to its canonical conversation at creation through existing receipts.
Edited/regenerated, interactive, failed-request retry and attachment-only sends
retain their existing paths.

Never-attempted pending or paused work supports prompt editing with the displayed
work revision. Editing paused work does not resume it. A stale edit retains its
draft until explicit refresh. The current input hash changes, so retrying the
original Send after a successful edit reports an idempotency conflict.

The composer shows a queue strip for that conversation's pending sends. Places
in line come from `submission_sequence` in one snapshot read per poll tick,
scoped to the current session; past one page, or for work that is not pending,
a row reads queued without a number. Withdraw reads the work's current revision
and cancels at it; the row stays visible as withdrawing until cleanup is
confirmed. Work paused by a restart shows Resume, never a position, and never
resumes on its own.

Refusal copy comes from one renderer map keyed by the runtime's own reason.
A wait (session busy, lane or runtime capacity, closing, transcript catch-up,
a mid-request run-mode change) is calm and states what it waits for; a decision
(runtime off, a full queue, an exhausted budget, a stale authority) is a danger
notice naming one next step. `submit` passes its closed reason vocabulary
through; any other failure stays the opaque submission refusal.

## Cleanup and verification

Tool dispatch shares the application resource broker. Filesystem operations use
physical path identity and revalidate authority before IO. File operations may
run concurrently on disjoint targets; commands with unknown effects exclude the
captured workspace. Commands claim resources after their existing approval,
and sandbox commands retain the downstream single-command cleanup barrier.
Desktop sandbox preparation has separate bounded ownership: snapshot copying
holds the captured filesystem resource until its file operations and closes
settle; worker creation holds native and sandbox capacity through exact-binding
approval. The unused live workspace and tool slot remain free during that wait.
After approval, a private capability reuses only that worker's held capacity
while trying the complete command resource set without queuing. Denial still
cleans up the prepared worker. Chat closure cannot certify that external worker;
failed snapshot closes or outstanding Docker CLI processes retain quarantine.
Readiness preparation and recovery also acquire native/sandbox capacity before
Docker work. A sidecar settlement cannot release a Node-owned operation; only
the captured application execution owner may settle it.
Cancelling a transport does not release a producer's resource lease. Uncertain
cleanup remains quarantined until its execution owner supplies confirmation.
Managed chat requires the paired tool-resource admission acknowledgement from
the current sidecar initialization; an older sidecar cannot silently bypass it.

Deleting a session captures its artifact cleanup authority before removing
metadata. Cleanup refuses a recreated session ID, a redirected filesystem
ancestor, or changed project authority. History deletion may report degraded
cleanup while retaining files whose ownership cannot be proved.

Preview windows use the existing shared browser owner. Unconfirmed destruction
retains capacity and appears in `cleanup_pending_sessions`; retry cleanup through
that owner after the producer can be confirmed stopped. A fresh operation cannot
replace an uncertain producer. Transient preview pixels are not continuation
state and are discarded if authority is lost during capture.

Deterministic fake-transport tests do not replace installed-app, real-model/GPU,
or hosted POSIX descriptor qualification. Those remain separate owner-run gates
in the manual matrix.

## Continuation foundation

The checkpoint codec, canonical artifact store and publication transaction are
connected to the managed pause/resume path, with activation withheld until the
paired sidecar advertises continuation support after integration qualification.
A valid reference alone cannot resume a turn: the runtime
must also verify the canonical material, the exact source attempt and current
authority. The first supported codec shape describes a resource wait before any
tool in the generated batch executes. It excludes approval waiters, prior side
effects and transient preview observations.

Checkpoint bodies plus their encoded canonical artifacts are bounded to 1 MiB each, 64 MiB in aggregate
and 4096 retained records. Exclusive publication preserves existing and future
data. Malformed state and uncertain partial writes require attention; they are
not deleted to make room. Until worker suspension, explicit resume and
archive/cleanup integration are complete, these foundations do not enable
automatic restart or resume.

The private `runtime.operation` checkpoint handler accepts only a captured
admitted context and an operation the application resource owner already marked
waiting. Its closed `kind: continuation`, `phase: checkpoint` request is bounded
to 1 MiB. The application supplies the canonical sequence, resource classification
and checkpoint identity. Identical concurrent retries share one transaction.
Capacity is reserved before the canonical artifact is published, and the commit
is acknowledged only after durable canonical proof and repeated attempt checks.
The acknowledgement does not prove worker or process cleanup.

The hidden canonical artifact retains the exact Python JSON bytes and digests for
the generated tool batch and frozen first-call input. Ordinary transcript export
omits this operational material. Resource provenance is checked against the
visible arguments actually admitted; the complete effective input, including
injected scope fields, is retained separately. A tools-only response can save an
empty event prefix without claiming that a tool started. Later-call resource
waits preserve their ordinary retryable outcome; they cannot use the first-call
checkpoint contract after an earlier tool has executed.

Each canonical artifact also binds a `history_ref` to the application-captured
history selector. The selector records the effective history scope after frame
fitting, the complete canonical prefix boundary and digest, and the normalized
persisted compaction snapshot digest when applied. It contains no transcript
text. Hashing complete rows deliberately invalidates earlier attachment or
metadata edits as well as text edits; later appended rows do not change the
captured prefix. The sidecar cannot supply or replace this selector.

The private managed pause boundary requires the exact published checkpoint in a
paired worker's paused response. It checks the current protocol initialization,
attempt, canonical material, unchanged captured events, absent approval waiters,
and zero active/reserved/quarantined operation capacity. It clears the journal
only with durable canonical proof, then asks the existing actor to release the
attempt without terminal projection. Publication alone never releases the actor.
The Python worker defers this response until request cleanup and exact worker
unregistration; this is not a claim that its OS thread has exited. Production
activation still requires the explicit resume and portable lifecycle gates.


## Durable new Send and explicit resume

Trusted desktop clients may call `sessionRuntime.submit` with an existing
canonical `session_id`, a stable `idempotency_key`, and nonempty new `prompt`.
Optional snake-case fields are listed in `services/ipc-contract-runtime-types.js`.
The closed schema excludes edited turns, interactive responses, failure retries,
caller-supplied authority, provider routes, work IDs and stream IDs. Those legacy
immediate-stream entrypoints retain their existing busy/admission behavior.

Submission uses the same request normalization as immediate Send, including local
inference selection and plugin/skill validation. It captures project/provider
scope, rechecks after asynchronous preflight and immediately before the durable
insert, then returns work/turn/session/project identity, revision, status and
`created`. No stream identity is returned. Pending work does not allocate an actor,
hydrate canonical history or start a producer. Dispatch runs after acknowledgement
and revalidates authority through the existing lane and final canonical claim.

An identical idempotency key/input returns its stored identity without dispatching
or resuming another attempt; changed input conflicts. Explicit pause, OFF, Stop,
session cancellation and deletion fence unfinished asynchronous submissions.
Restart restores queued records paused. `sessionRuntime.resume` accepts only
`work_id` and `expected_revision`: a never-attempted record starts its first turn
without fabricating a checkpoint, while attempted work still needs its validated
checkpoint. Resume remains disabled while runtime is OFF or closing. Errors use
bounded CMP runtime responses without raw provider or filesystem details.

The desktop bridge exposes these operations; composer integration and browser
transport parity remain later approved work. Merely inspecting/opening a session
continues to authorize no work.


### Explicit active pause

`sessionRuntime.pause({work_id, expected_revision})` uses the trusted desktop
invoke bridge and the same closed revision request as resume. Pending work
becomes paused immediately. Running work returns `status: requested` after
persisting pause intent and retains its actor and lane. A request-local
`runtime.operation` pause probe can settle only the existing eligible first-tool
boundary, after approval/prefilter checks and before any tool execution event or
effect. If that boundary has passed or is unsupported, intent does not fabricate
a checkpoint; normal completion or explicit cancellation still settles the turn.

The composer shows Pause beside Stop only while the session runtime owns the
reply in progress in this conversation (the stream was admitted through the
durable Send path; an edit, a retry or a legacy stream has no running work, so
Pause stays hidden). It reads one session-scoped snapshot, takes the running
work, re-reads that work's revision and calls `pause`; with no running work it
refuses with `runtime_no_running_reply` rather than pausing a queued message,
which is withdrawn from the strip or paused from Settings › Runtime. A running
reply returns `status: requested`: the control reads "Pause requested…" and
disables, and the composer says the pause lands at her next approval and that a
reply needing no approval simply finishes. That request settles only when the
sidecar offers a tool-approval decision before the tool runs (auto-approved
tool calls never offer one), so the poller that already runs watches it on the
same 2-second tick and one snapshot read; when the work turns paused the notice
becomes "Paused. Resume from the queue strip when you're ready.", when it
completes, fails or is cancelled the request and its notice are cleared rather
than left implying a pause is still coming, and a request the runtime can no
longer answer (three silent reads) is dropped and logged. Every pause notice is
written and cleared only in the conversation that paused, through the
owner-scoped notice API, so a pause settling while another chat is on screen
touches nothing there. Paused work with no pending entry gets a synthetic
queue-strip row keyed `work:<work_id>` with no position number, a Resume button
that re-reads the revision before resuming, and a Discard button that cancels at
the fresh revision (the transcript keeps what was written; the row leaves once
the snapshot no longer lists the work as paused); Resume is disabled and reads
"Jenny is shutting down" while the snapshot reports `closing`. Nothing resumes
on its own.

A pinned "Needs you" section sits at the top of the Chats panel whenever
anything is waiting on the person, in any conversation, opened or not, and a
quiet dot-and-number mark beside the titlebar health pill mirrors it (clicking
the mark opens the panel and scrolls the section into view). It is written in
the panel's own language -- the same kicker as "Today", plain rows with no
boxes, and decisions as text -- so it reads as another group in the chat list
rather than a card stack pinned above it. Every row's title is a button that
opens that conversation, because a wait is answered here out of its context and
one click should get you back to it; opening decides nothing. It lists three
kinds of wait, and nothing else. A tool approval is answered in place with
Allow, Always allow and Deny -- "Always allow" appears only where the
approval card in the transcript would offer it -- and the row always names the chat, the tool, the
exact arguments (bounded to one line, with the clip saying how much it hid) and
the same writes-or-not facts, scope and consequence the card shows, or the
card's "Review requested input" line when nothing was declared, because it is
read out of the conversation's context. Nothing reads as approved before the
bridge answers: a decision that arrives too late reads "Already resolved", raises
the same "already resolved or no longer active" notice the transcript card
raises (the row leaves on the next pass, so the notice is what the person
keeps), and a failed call re-enables the row instead of stranding it. A plan waiting for review offers Open, never an approval, because
a plan is read before it is accepted; a pending question batch says how many
questions wait and offers Answer, which opens that conversation, where the
question block lives. The section is bounded and scrolls inside itself, so a
long list of waits never pushes the chat list out of the panel; it yields by
its list rather than its heading, and the chat list keeps a floor of three
rows, so neither pinned section can squeeze it away on a short window. It can
be collapsed (the choice is remembered, and the count stays visible). There
are no timestamps, no costs and no counts of parallel work here -- only what is waiting and what can be done about
it -- and the section refreshes on the passes that already redraw the chat list
and the session strip, so it adds no polling of its own.

Home's main column carries "While you were away" after Calendar: everything
that finished, failed or was cancelled since you last looked, newest first. A
row shows the chat title, an outcome word only when the outcome was not a
success, and the relative finish time -- never a reason the record does not
carry. Hovering a title fetches and shows the started time and token counts;
tokens are never shown as money. "Show all" expands a truncated list and "Mark
all seen" clears the current global list. Work older than 30 days may show
"Older than 30 days; Jenny may keep only the outcome." The timestamp supports
only that "may": after 30 days Jenny compacts a settled run's input and keeps
its summary.

If a referenced chat has been deleted, its rows remain as "Chat deleted" rather
than inventing detail. If the runtime list cannot be read, the card keeps the
rows it already had, says "Couldn't read the runtime list.", and offers Retry
instead of presenting an empty digest. Opening a chat clears that chat's digest
rows and its sidebar outcome dot. Chat rows reserve one dot at the left: muted
means a run finished since that chat was last looked at, danger means the last
run failed, and live streaming or waiting takes priority. Hover text adds a
third line, "Finished · {when}" or "Last run failed · {when}". The seen marks
are device-local, and nothing here claims they sync.

Explicit pause has no resource dependency or automatic wake. Canonical prefix,
checkpoint, actor/journal settlement and physical cleanup must all be proven
before capacity is released. Cancellation supersedes pause. Restart retains the
intent; a valid recovered checkpoint still requires explicit resume. Approval
waiters, ask-user waits that already started, previews/vision, later iterations
and previous effects remain outside this slice. The sidecar continuation
capability remains withheld pending qualification, so this does not claim active
pause is enabled in the user application.


### Transcript cache admission

The canonical store reports unknown dirty bytes or retained bytes above its
64-MiB ceiling as cache pressure. New runtime admission stays pending without
an actor or transcript hydration; admitted producers retain their authority and
capacity. Dirty and active-turn records remain retained. Clean inactive history
still obeys the existing 30-entry/64-MiB eviction limits.

Settled file writes signal the backend through a coalesced availability callback.
The backend rechecks durability, prunes eligible clean records and wakes pending
admission plus retained resource eligibility only when pressure is clear. Failed
session/index writes keep pressure closed. OFF, closing, explicit pause, deletion
and disposed stores cannot reopen work through that callback. No polling or
per-work cache timers are introduced.

### Terminal detail retention

At idle startup and before a new Send, maintenance scans at most eight summary
rows, continuing its cursor on the next pass. Terminal detail older than 30 days
can be replaced by the closed `terminal_tombstone` input v1. Work/session/turn
identity, original submission hash, outcome, attempt and bounded audit fields
remain; attempted turns retain a canonical session/turn result reference. Exact
repeated submissions still return the original work, including after restart or
portable restore. Tombstones cannot be submitted or resumed.

The application permits compaction only for immediate-chat input with settled
runtime resources, no actor/journal barrier, durable canonical data and a matching
assistant result. Never-attempted cancellation needs no transcript read. Missing
proof defers compaction. The checkpoint owner must affirm no evidence from ANY
attempt; orphaned preparing/committed records and unreadable inventory veto it.
Checkpoint-backed work and all nonterminal records retain
their detail. Checkpoints, receipt records, dependencies, budgets, artifacts and
canonical history are untouched. Existing index/record caps still reject new work
at capacity; tombstones are never evicted to reuse an idempotency key. Compaction
uses the existing write-ahead journal and fails closed on uncertain publication.

### Child cancellation and repeated dependency waits

Parent cancellation fences its retained descendants before propagating abort.
Root lineage cancellation is durable; failed publication remains fenced until
recovery and an explicit retry prove cleanup. Session cancellation includes child
producers in other sessions. Restart finishes already-recorded cancellation without
resuming work; missing lineage evidence cannot claim complete cleanup.

Repeated `before_dependency_wait` checkpoints use closed body schema2. Each binds
the exact prior checkpoint and retains cumulative completed spawn/wait references.
The application rechecks canonical result bytes, direct-child lineage, historical
selectors and nonincreasing remaining budgets before publication and hydration.
Chains retain the existing20-artifact and256-call bounds. Early tool announcements
are optional; when present, the pending request is retained as evidence and excluded
from provider history until its saved execution. Text projections retain their exact
application IDs and hashes. No prior tool effect is replayed. Production continuation
capability advertisement remains withheld pending the remaining program gates.

### Completed-work retention

Idle maintenance scans at most eight summary rows per pass. After 30 days, settled
root/child work can replace request detail with a closed v2 terminal tombstone.
Original submission identity/hash, root grants, child lineage metadata, outcome and
canonical result links remain; duplicate Start returns the original work without
execution. Lineage records and all settled budget receipts remain unchanged.

Committed checkpoints retire newest first. The checkpoint owner durably records an
exact terminal-work retirement intent, the ledger journals removal of an attached
reference, and the canonical owner durably removes only its checkpoint artifact.
Only then does the checkpoint owner replace the encoded body with an inert identity
and reclaim body/artifact byte charges. Canonical messages, turn events and results
remain. Preparing/orphan evidence, unsettled receipts, young/live descendants,
publication, cancellation fences and physical/quarantined resources veto retirement.

Startup finishes saved retirement intents before normal continuation discovery.
Incomplete retirement blocks both live and offline portable capture. Archives retain
inert checkpoint and work identities; restored terminal records cannot resume. The
4096-checkpoint identity cap remains, while retired bodies no longer consume their
original byte charge. Session deletion still follows the existing lineage veto.


### Browser durable work

The browser uses the same durable runtime owner as desktop. A successful Send
receipt identifies saved work and its logical turn before a producer starts.
Later stream events carry the exact admission identity. More Sends can queue
while the selected conversation is running; unresolved transport receipts retain
their exact request identity for recovery. Paused work stays paused after host
reconstruction or switching runtime ON until explicitly resumed.

Open Runtime & orchestration to inspect work and use Start, pause, resume, cancel,
pending instruction edits and runtime limits. Session mutations require the current
browser control lease and both the host revision and work revision. Authentication
or lease loss fences changes; hidden inspection stops polling. Cancellation intent
and confirmed physical cleanup remain distinct.

Staged media referenced by nonterminal durable work survives the upload expiry
sweep, including paused work after restart. Cleanup reads the canonical runtime
ledger and fails closed when its references cannot be proven. Terminal media still
referenced by conversation history remains owned by that history.


### Completed typed mutations at decision waits

Decision checkpoint body schema6 and canonical artifact entry schema4 bind a
settled typed-mutation prefix to the authoritative version1 workspace journal.
They retain an immutable prefix digest, workspace/change-set identity and exact
work, decision and source-attempt binding. The application reads the fixed profile
journal with schema, canonical-byte, integrity and physical-root checks; Python
alone performs pin, claim and release under the existing owner locks. Older
checkpoint/artifact versions retain their existing semantics.

A reusable builtin MCP process binds its trusted profile recovery and snapshot
services to each freshly verified project root. It never reconciles other live
journals when admitting a scoped tool call. Startup reconciliation preserves a
valid preparing or confirmed settled prefix pending application arbitration.
Only a confirmed pin can be claimed. Resume retains consumed decision
and attempt identities, and continues the same logical-turn change set. A pin
never supplies consent: pending inputs pass current policy and fresh approval or
question handling. Completed approval display events require matching canonical
approval, execution and result evidence before inclusion.

Paused cancellation persists intent and retains its fence until the private
`workspace.release_runtime_checkpoint` RPC confirms the exact owner binding.
The method uses the workspace RPC `accept_version` contract and is absent from
renderer IPC and model tools. Release marks the journal interrupted, retaining
protected effects and the binding as an inert cancellation record. Initialization
retries persisted paused cancellation with bounded concurrency. Publication
failure or ambiguity also releases replay eligibility while retaining recovery
evidence; unconfirmed physical cleanup remains quarantined. Checkpoint retirement
requires matching terminal journal evidence and never discards an active pin.

Focused integration coverage is `tests/session-runtime/mutation-stdio.test.js`;
owner/replay and cross-language byte proof live in
`tests/sidecar/ai/tools/test_workspace_mutation_checkpoint.py` and
`tests/session-runtime/mutation-journal-proof.test.js`. Pending mutation inputs,
uncertain/uncovered operations, active restore, quota state without its own proof,
and mixed dependency/mutation histories remain ineligible.

Publication binds a preparing pin before canonical commit and confirms it afterward.
`workspace.reconcile_runtime_preparations` interrupts only unpublished exact work/
source preparations. `workspace.confirm_runtime_checkpoint` confirms an exact published
pin after application canonical hydration proof. Both private methods use the fixed
profile owner, verified physical project root and existing journal locks. Sidecar-only
interrupted settlement with pause/cancel intent can repair to paused with the exact
checkpoint; cancellation intent survives and cannot authorize resume. Actor cleanup
failure remains fenced and can retry after another restart. Terminal work is not reopened.

Preparation maintenance scans at most64 records and issues at most16 RPCs within15s
(at most3s per request). The runtime store's `mutation-recovery-cursor.json` rotates
past inspected/skipped records across initialization. It carries no authority: invalid
cursor data resets the scan; cursor IO failure reports blocked work while chat remains
usable. Unprocessed or uncertain journals retain their evidence. Crash and fairness
coverage is `mutation-preparation-recovery-stdio.test.js` and
`mutation-preparation-recovery.test.js`, with exact attachment/actor retry negatives
in `checkpoint-restart-recovery.test.js` and `store.test.js`.


### Capacity waits after completed tools

Managed resource waits preserve exact completed results, pending order, quota
admissions and consumed budgets across restart. Only the unstarted suffix resumes;
current authority, policy and resource availability are checked again. Electron
producers use separate prepare/start exchanges so a resource wait never announces
execution. Verification reaches its existing test-runner resource owner. Sandbox
commands wait before snapshot, worker or command admission; a prepared worker and
snapshot must be removed before the wait can suspend. Unconfirmed cleanup retains
recovery-required state and cannot become a resumable checkpoint.
