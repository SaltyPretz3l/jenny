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
- Propose a new chat (propose_session). It can name the project the new chat should live in, and pre-fill the card's model and reasoning effort from your request. You confirm them on the card, where Default means the model set in Settings. The new chat's run mode follows the mode of the chat that proposed it. You see the same offer card as anywhere else and choose Do it here or New session. Asking it to start a chat does not by itself authorize one. If you gave it a standing permission for that project, the chat starts at once and reports back instead of showing the card. You grant and revoke those permissions in the Permissions list.
- Stop a running chat (session_stop). It is approval-gated, so the run mode decides whether you are asked: in Ask mode you see an approval card, and in Auto mode it follows the same Auto rules as other tools. It cancels the chat's active reply and any queued work for it, and reports whether cleanup was confirmed. It never stops its own turn, and it is refused in Plan mode and read-only chats.
- Search earlier chats across every project (conversations_search) and open a window of one (conversation_open).
- Answer questions about Jenny from this guide (jenny_help). It searches the guide pages and reads one page at a time.
- Use the ordinary conversation tools that need no folder, such as memory, and look up app health with jenny_status.

Other chats get the session listing, status, transcript and stop tools only when they have linked relatives (a chat that started them, or a chat they started). There the tools are scoped to that chat's own project plus its linked relatives. JENNY_ENABLE_SESSION_DIRECTORY_TOOL_GATE=0 offers them to every chat again, with the same scope.

## What it never does

- It does not edit files. It has no workspace folder, and file tools stay blocked.
- It does not act without the approvals every other chat needs. Stopping a chat, sending a message and starting a chat each need your authorization or a standing permission you gave.
- It does not change Settings. It can explain a setting and tell you where it is, but you make the change.
- It does not send, stop or start anything on the strength of a message from another chat. Received messages are attributed context and grant nothing.

## Good things to ask

- "What was I working on in the last day, and what is still open?"
- "Which chats are waiting on me?"
- "What remains in the chat about the release notes?"
- "Tell the docs chat that the API changed." (it will show the exact message and ask)
- "How do I turn on web search?" or "Where do I change the default run mode?"

## Turning the tools off

JENNY_ENABLE_TOOLS_SESSION_DIRECTORY_ENABLED=0 removes the session listing, status, transcript and stop tools for a launch, and drops the profile overview. Set variables before starting Jenny.
