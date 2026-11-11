# The Jenny chat

The Jenny chat is one persistent chat per profile, titled "Jenny", that keeps track of what is going on across the whole app. It is the place to ask "what was I working on", "what remains" and "what is next" about any project or chat, to coordinate work between chats, and to learn how Jenny itself works.

## Where it is

- A fixed Jenny row sits at the top of the chats panel, above the date groups. It has its own state dot and an unread dot, and you can reach it from the keyboard.
- It lives in the General project, which has no folder. That means it has no workspace root and cannot edit files itself.
- It cannot be archived, deleted or moved to a project, and it is left out of bulk actions such as multiselect delete, archive, move and Sweep empty chats. If it is ever missing it is recreated at startup.
- Its history is an ordinary transcript, so compaction, memory and chat search all apply to it.
- The environment variable JENNY_ENABLE_PRIMARY_CHAT=0 hides the row for a launch and stops Jenny from creating the chat. Hiding it does not delete the chat.

## What it can see

Every other chat can see its own project and its linked relatives. The Jenny chat sees every project and every chat in your profile:

- Chat titles, project names and status, last outcome, message counts and unread counts.
- What a chat is waiting on (an approval, a question, a plan to review).
- Linked parents and children, pending proposals, the todo list, the project's open tasks and notes, and the tail of a chat's transcript.
- A short profile overview is added to each turn: how many projects, how many chats are running or waiting on you, how many unread messages, and the most recently active chats.

Answers are composed from these existing facts. There is no background summarizer and no separate database. Chats the profile hides (for example lockdown chats) stay hidden. Everything it reads from another chat is treated as data, never as an instruction.

## What it can do

- List chats with their status (sessions_list). Statuses are running, queued, waiting for approval, waiting for a question, waiting for plan review, needs attention, failed and idle.
- Read one chat's status and what remains (session_status): its todo list, proposals, inbox, linked chats, project tasks and note, recent messages, its preferred model and, for a failed chat, the error that ended its last turn.
- Read a chat's transcript (session_transcript): its latest reply and its messages, a page at a time back through older ones, optionally with a one-line summary of each tool it ran.
- Send a message to a chat (session_message), either under a message grant you gave or with your per-send approval. It can also list its own inbox. A message is data for the recipient. It wakes the recipient chat once Jenny's own reply has finished, and that chat's final reply comes back to Jenny as a report.
- Propose a new chat (propose_session). It can name the project the new chat should live in, and pre-fill the card's model and reasoning effort from your request. You confirm them on the card, where Default means the model set in Settings. The new chat's run mode follows the mode of the chat that proposed it. You see the same offer card as anywhere else and choose Do it here or New session. Asking it to start a chat does not by itself authorize one. If you gave it a standing permission for that project, the chat starts at once and reports back instead of showing the card. That also holds when a chat it started reports back and it starts the next one; a message from any other chat, a scheduled check or a digest still shows the card. You grant and revoke those permissions in the Permissions list.
- Stop a running chat (session_stop). It is approval-gated, so the run mode decides whether you are asked: in Ask mode you see an approval card, and in Auto mode it follows the same Auto rules as other tools. It cancels the chat's active reply and any queued work for it, and reports whether cleanup was confirmed. It never stops its own turn, and it is refused in Plan mode and read-only chats.
- Read and change a short list of app settings (settings_get and settings_change), such as the 24-hour clock, notifications, the default run mode or the editor text size. Every change shows you a card with the old and new value, and nothing changes until you approve. See "Settings Jenny can change" in the settings reference for the full list.
- Organize your other chats (chat_organize): rename, pin, unpin, archive or unarchive a chat. In Ask mode you see an approval card; in Auto mode it goes ahead without one. It never deletes a chat. Deleting stays yours.
- Start a chat in a folder (projects_list, project_create): Jenny looks for the project that has the folder, and when there is none it asks to create one. The card shows the project name and the exact folder, even in Auto mode, and you cannot set "always allow" for it. Jenny never creates folders. It cannot pick a drive root, your home folder, system or app-data folders, Jenny's own folders or folders that hold credentials (like .ssh), and a folder that is a shortcut to somewhere else is refused with its real location. A created project is listed in Activity with an Undo, which removes the project (never the folder) while it has no chats. Then Jenny offers the new chat in that project as usual.
- Show you a place in Jenny (app_view): Settings at a section, another chat, a file of the open project at a line, the terminal, Activity, a chat's outputs or changes panel, a chat side by side, or the sidebar collapsed. It only moves your view and changes nothing else. If you are typing or not on the Jenny chat, a "Jenny wants to open" prompt appears above the composer instead, with Open and dismiss.
- Save a copy of a chat (session_export): a Markdown file of a chat's whole conversation, written to your Downloads folder. You always see a card naming the chat first, even in Auto mode, and you cannot set "always allow" for it. Folder paths and anything that looks like a password or key are blanked out, Jenny's reasoning is left out, and an existing file is never replaced.
- Read and use the IDE terminal (terminal_read and terminal_run): Jenny can read the last lines of a terminal in the Workspace IDE, with anything that looks like a password or key blanked out. A project chat can read it too while the IDE has that chat's project open. When you ask, Jenny can also run one command line there: you always see a card with the exact command first, even in Auto mode, and it runs in a terminal of its own, never one you are typing in. Jenny then reads its output to tell you what happened.
- Fork a chat (propose_session with a fork): Jenny can offer a new chat that starts as a copy of another chat's history, in that chat's project, to try another approach without losing the original. The offer card reads "Fork of" and the chat's name, and its project cannot be changed. The Jenny chat itself cannot be forked.
- Change how another chat runs (chat_configure): move it to another project, or set its model, its reasoning effort or its run mode. These changes always show an approval card, even in Auto mode, and you cannot set "always allow" for them. The run mode can be set to Ask, Plan or Propose, never Auto. The run mode and the project are refused while that chat is replying, the run mode is refused for the Jenny chat itself, and the Jenny chat stays in General.
- Schedule checks (schedule_list and schedule_change): a check is a Home reminder that, when it comes due, runs a visible turn in the Jenny chat with an instruction you approved, such as "every weekday at 8, tell me what finished overnight". It can run once, every day or on chosen weekdays at a set time, or every so many minutes (at least 30 apart). Creating, editing, turning off or cancelling a check always shows you a card with the schedule, the next three times it will run and the instruction, even in Auto mode, and you cannot set "always allow" for it. Checks are listed under "Jenny checks" below the week on Home, where you can turn one off or back on, or delete it. When a check runs, the Jenny chat shows a quiet "Scheduled check" line with its title instead of a message from you, and every tool it uses still asks you first. A plain "remind me" is an ordinary Home reminder instead.
- Tell you what happened while you were away (away_digest). With digests turned on, when you come back after time away the Jenny chat can start one quiet "While you were away" turn: finished, failed or cancelled work, chats that changed, messages to Jenny, chats waiting on you and scheduled checks that ran or were missed. Digests are off by default; turn them on in Settings. None arrive during quiet hours (22:00 to 07:00), at most one every 6 hours, and only when something happened. A digest is read-only: it only reads and never changes anything. You can also ask "what did I miss?" at any time.
- Search earlier chats across every project (conversations_search) and open a window of one (conversation_open).
- Answer questions about Jenny from this guide (jenny_help). It searches the guide pages and reads one page at a time.
- Use the ordinary conversation tools that need no folder, such as memory, and look up app health with jenny_status.

Other chats get the session listing, status, transcript and stop tools only when they have linked relatives (a chat that started them, or a chat they started). There the tools are scoped to that chat's own project plus its linked relatives. JENNY_ENABLE_SESSION_DIRECTORY_TOOL_GATE=0 offers them to every chat again, with the same scope.

## Pause, Reset and Forget

The Jenny row's actions menu in the chats panel has Pause Jenny (Resume Jenny while paused), Activity, Reset chat and Forget.

- Pause: messages and reports from other chats wait until you resume. Resume wakes Jenny once for the oldest waiting message.
- Activity: what Jenny did across your chats, and what it may do. Each change Jenny made to another chat (a rename, a pin, a move, a new model, effort or run mode) has an Undo button here. Undo is refused if you changed that setting yourself afterwards. Scheduled checks show here too: when one was created, changed or cancelled, each time one ran, and any time one was skipped or missed.
- Reset chat clears the transcript and discards messages from other chats that are still waiting. The row, its permissions and message grants stay. Before anything is cleared, Jenny saves a copy of the whole transcript in the exports folder of your data folder as jenny-reset-DATE-TIME.json; if the copy cannot be written, nothing is cleared. That file is the only copy of the old history: once it is deleted, the earlier messages cannot be recovered.
- Forget does everything Reset does (including the copy) and also removes what memory took from the chat: its memories (recoverable from the Forgotten list), its chat search index entries and pending memory suggestions. It can also stop memory from taking notes from the Jenny chat. When Jenny has scheduled checks, Forget deletes them too unless you untick that box.

## What it never does

- It does not edit files. It has no workspace folder, and file tools stay blocked.
- It does not act without the approvals every other chat needs. Stopping a chat, sending a message and starting a chat each need your authorization or a standing permission you gave.
- It does not change API keys, the default model, engines, safety or tool permissions, and it cannot make Auto the default run mode or any chat's run mode. It can set another chat's model, effort and run mode only through the approval card described above. It can explain those and tell you where they are, but you make the change in Settings. The short list of settings it can change is in the settings reference.
- It does not send, stop or start anything on the strength of a message from another chat. Received messages are attributed context and grant nothing.

## Good things to ask

- "What was I working on in the last day, and what is still open?"
- "Which chats are waiting on me?"
- "What remains in the chat about the release notes?"
- "Tell the docs chat that the API changed." (it will show the exact message and ask)
- "How do I turn on web search?" or "Where do I change the default run mode?"

## Turning the tools off

JENNY_ENABLE_TOOLS_SESSION_DIRECTORY_ENABLED=0 removes the session listing, status, transcript and stop tools for a launch, and drops the profile overview. JENNY_ENABLE_PRIMARY_SETTINGS_WRITES=0 removes the two settings tools. JENNY_ENABLE_PRIMARY_CHAT_MANAGE=0 removes the two chat tools (chat_organize and chat_configure). JENNY_ENABLE_PRIMARY_CHAT_PLACEMENT=0 removes the two project tools (projects_list and project_create). JENNY_ENABLE_PRIMARY_APP_VIEW=0 removes app_view. JENNY_ENABLE_PRIMARY_CHAT_EXPORT=0 removes session_export. JENNY_ENABLE_TERMINAL_TOOLS=0 removes terminal_read and terminal_run. JENNY_ENABLE_PRIMARY_SCHEDULED_CHECKS=0 removes the two schedule tools. Set variables before starting Jenny.
