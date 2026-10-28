# Chats and projects

## Projects: a folder Jenny works in

A project is a folder Jenny works in. Its chats, memories and file access stay with it. In practice the Workspace folder is the project: when you choose a Workspace folder, Jenny creates the project for it, and new chats start in the current project.

- General is the project with no folder. Chats in General can talk, but file tools are off for them. General cannot be deleted and cannot own a Workspace folder.
- A chat with no Workspace folder shows a hint: "No Workspace folder set - file tools are off for this chat", with a Set Workspace folder button.
- The project pill inside the composer's chat-tools panel picks which project a chat belongs to. Moving a chat to another project (row menu, Move to project) moves its file access and memories with it. A busy chat is skipped, and the move offers Undo.

### Managing projects

Settings > Projects lists Your projects with their chat counts and last use. From there you can:

- Start a New project from folder.
- Open one as the Workspace, Rename it, Change folder, or Reveal folder.
- Start a New chat here.
- Delete a project. Its chats move to General, its memories are archived with it, its knowledge folders move to General, and the folder and its files stay on your disk.

If a project's folder goes missing, the switcher marks it "folder missing" and offers Locate folder. A project that is the open Workspace cannot have its folder changed until you open another project.

## The chats panel

The Chats panel on the left of the Chat view lists your conversations. Ctrl+B collapses it to a narrow strip of up to 12 chips; Ctrl+N starts a new chat.

- Search: the Search chats box matches titles and previews. It shows the first 200 matches; the panel itself shows the newest 500 chats.
- Project filter: Show chats from a single project, or All projects.
- Groups: Pinned first, then Today, Yesterday, Previous 7 days, Previous 30 days and Older.
- Archived: archive a chat from its row menu and it moves to the Archived view. Unarchive restores it.
- Row menu: Open in New Tab or This Tab, Pin or Unpin, Archive, Rename chat, Move to project, Send to chat, and for linked chats a Report back to the original chat checkbox.
- Multiselect: bulk archive, restore, move, and delete. Deleting asks for confirmation and offers Undo, and a busy chat is protected.
- Sweep empty chats deletes untitled chats that have no messages.
- A small dot on each row shows its state. Waiting on you (an approval, a plan to review, or a question) outranks streaming, which outranks open and idle. A badge shows queued sends.
- Linked chats nest below the chat they came from. See linked-chats-and-messaging.

Open chats also appear as tabs above the conversation. Ctrl+Shift+\ opens or closes a second pane so you can see two chats side by side, each with its own timeline and composer.

## The Needs you inbox

A bounded inbox sits above the chat groups, titled Needs you, with a badge such as "2 things need you". It lists everything waiting on you across chats:

- Tool approvals, with Allow, Always allow and Deny right in the list.
- Questions Jenny asked, with an Answer button that opens the chat.
- Plans ready for review, with Open.
- A message that is stuck waiting to start.

Desktop notifications can announce the same events; see settings-reference for the Notifications section.

## The session summary (session rail)

Each chat has a session summary on its right side, titled Session. Open it with the Session summary button and hide it with Hide session summary. Each split pane shows its own facts. Unknown, unavailable and stale values are labeled as such; they are never shown as zero.

- Environment: the project, whether the chat runs Local, Hosted or in the Sandbox, and the Git branch or worktree when there is one.
- Context: how much of the context window is used, with a breakdown (system prompt, tool definitions, workspace instructions, other context) and what is available. For the next send it is an estimate, and retrieval may add context.
- Outputs: files and artifacts this chat produced. "Nothing produced in this chat yet" when empty.
- Changes: the working-tree changes in the chat's workspace, with a file count and Review changes. A non-Git folder shows "Not a Git repository". This is the working tree, not a promise that this chat made every change.
- Background tasks: running, waiting, failed and finished work attributed to this chat and its linked chats, with View activity. Sources include Linked chat, Session run and Workspace tests.
- Performance (optional): turn on Settings > Appearance > Show performance in the session rail for writing speed, prompt reading, time to first token and cache reuse.

## The Jenny chat

One chat in the General project is pinned at the top of the panel: the Jenny chat. It cannot be archived, deleted or moved. It can see every project and chat, and it is the best place to ask questions about the app. See jenny-chat.
