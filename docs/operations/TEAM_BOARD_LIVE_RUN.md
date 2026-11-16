---
kind: operations-doc
last_reviewed: 2026-11-15
---

# Team boards: the two-member live run (row 151, slice T8)

This is the owner's run. It is the first time a team board is seen in the app: everything in row 151 was
built and tested without launching it. Plan and records: the board plan,
section 8 and, in section 13, the wave 7 to 10 records and the P5 and T9 record.

Every launch here is yours to do. Nothing in this guide changes a setting on the host or a router.

## What you need

- Two PCs on the same build of the `wt/team-board` branch, each passing `jenny doctor --team`
  ([getting a second PC ready](TEAM_SECOND_PC.md)).
- Team on in both apps. It is on by default on this branch; a PC that still carries `JENNY_ENABLE_TEAM=0`
  from an earlier test has it off (see that guide). Boards are on by default
  (`JENNY_ENABLE_PROJECT_BOARDS=0` turns them off).
- One team with one team project, and two members in that project: call them A and B. Make A an admin of
  the project and B a writer. For step 9 you change B to a reader.
- A local model on the PC that runs the team's turns, for steps 6 and 7.
- On A's PC, one board of A's own (not a team board) that holds a note, a picture and a chat card, for step 8.

## The run

Write down the step number and what you saw for anything that differs from "Expect". A screenshot helps for
anything about looks.

| # | Do | Expect |
|---|---|---|
| 1 | A: open the Board tab. Click the project name at the top of the board list. | The name is a button with a small arrow, and its tooltip says "Choose a project". A menu opens under it: "My projects" with A's own projects, then "<team> team" with the team project. The project shown now has the check mark. |
| 2 | A: pick the team project. Make a board named "Plan" and add two notes. | The list shows the team project's boards. Under the list: "Shared with the members of <project>. The host can read it." Undo and Redo are off and say "Undo and redo are not available on a team board." |
| 3 | B: open the Board tab, pick the same team project, open "Plan". | B sees A's two notes without reloading. Hovering a note shows "Added by <A's name>". |
| 4 | Both: move the mouse over the canvas. A: drag a note. B: add a note. | Each sees the other's pointer as an arrow with their name, moving a few times a second. A's drag and B's note appear on the other PC within about a second. Nobody sees their own pointer drawn. |
| 5 | A: double-click a note and start typing. B: look at that note, then try to edit it. A: press Escape. B: edit it now. | While A edits, B sees "<A's name> is typing" over the note, and B's attempt opens no editor and says "<A's name> is editing this note." After A leaves the note, B can edit it. |
| 6 | A: open the chat beside the board (the chat button of the Board tab). If the project has no conversation, click "New conversation". Ask Jenny: "Add three notes about risks to this board." | The column shows the project's conversation, with its title as a button that lists "Conversations in <project>". Above the message box: "Jenny can see this board from here. The host and the computer that runs the model can read it." With B on the board the head says "<B's name> and you are viewing". Jenny's reply ends in a proposal on the board. |
| 7 | B (who did not ask): look at the proposal. Accept the additions. Then A: ask Jenny to change one note's text, and B: accept that one change. | The proposal says "<A's name> asked. Anyone who can write in this project and is viewing this board can answer." "Accept additions" adds every new note at once. An edit or a removal has its own Accept, one at a time. After B accepts, A's proposal shows it as accepted too. In the Team tab, the project's Activity says "<B> accepted 3 board changes that <A> asked Jenny for" (the number that was added), then "<B> accepted a board change that <A> asked Jenny for". |
| 8 | A: switch to "My projects", open A's own board, open Export, pick "Copy to a team project…" and pick the team project. Then open the copy in the team project. | The menu notes "Chat cards are copied as their titles only." A toast says "Copied to <project>." In the copy the note and the picture are there, and the chat card arrived as a plain note holding the chat's title. B sees the new board in the list and can open the picture. |
| 9 | Host or project admin: change B to a reader of the project. B: look at the Board tab. | B's page reloads the project by itself. New board, rename, Duplicate and Delete are off with "You can look at this board. Writers and admins of this project can change it." (or the project wording). B can still open boards, move around, and B's pointer still shows on A's screen. B cannot answer a proposal. |
| 10 | A: click the Chat tool in the board's toolbar and pick a conversation. Then press Enter on the new chat card. | The menu lists this team project's conversations (none of A's own chats). The card is added. Enter opens that conversation in the chat column beside the board. |
| 11 | A (admin): delete a board, then click Undo on the toast. | "Board deleted." with Undo; Undo brings it back for both members. The project's Activity says "<A> deleted a board" and "<A> restored a board". |
| 12 | B: quit Jenny while A keeps the board open. A: add a note. B: start Jenny again and open the board. | A's head line stops naming B within about a minute. B sees A's note after reopening. |
| 13 | A: pick a project under "My projects" again. | The Board tab is A's own again: no team line under the list, Undo and Redo work, the chat column is A's own chat. |
| 14 | A and B: pick the team project again and open "Plan" with the chat column open. Each: click the clock button in the column's head (tooltip "History: who changed this board"). | The column shows "History" in place of the conversation, with "Back to the conversation". A (admin) reads "The last 200 changes to this board. As a project admin you can take one back; that is recorded in the project's Activity." B reads "The last 200 changes to this board. A project admin can take one back." Under "Today", one line a change, newest first: the time and a sentence such as "<B's name> added a card" or "You moved 2 cards". The sentences count cards, connections and groups; they never show a card's text. |
| 15 | B: add two notes. A: in History, point at B's newest line, click "Take back", read the question, click "Take back" again. | B's line appears in A's History within about a second without reopening it. "Take back" shows on the line under the pointer (and on the line that holds the keyboard focus). The question is "Take back <B's name>'s change? Its cards, connections and groups go back to how they were before it. Anything changed since then is left as it is." After it: B's two notes are gone on both PCs, B's line says "Taken back", and a new line on top says "You took back a change by <B's name>" (B reads "<A's name> took back a change of yours"). B sees no "Take back" on any line. The project's Activity records it. |
| 16 | A: delete a board and let the toast go without Undo. Look under the boards list. Click "1 deleted board", then "Restore". B: look under the boards list at the same time. | A sees "1 deleted board" under the count of boards. Open, it lists the board's name, "<who deleted it> · 7 days left" and "Restore", and the note "Who deleted it, and how long it is kept. After 7 days a deleted board is removed for good." Restore brings the board back into the list for both members and says "Restored <name>." B (a writer) never sees the deleted boards line. |

## Known before the run

These are recorded in the plan's section 10 and are not findings:

- Pointers and the "is typing" label grow and shrink with the canvas zoom.
- A member renamed while a board is open keeps the old name in card tooltips until the board is drawn again.
- A History line counts what changed ("removed 3 cards") and does not name the cards, and a change can be
  taken back only while it is among the board's last 200.
- A change whose cards were changed again afterwards is taken back only in part; the page says so once
  ("Part of that change could not be taken back: the board has changed since.") and the line still reads
  "Taken back".
- A chat card opens its conversation but does not scroll to a message.

## What to send back

- The step numbers that differed, with what you saw.
- How the heading button, the two menus, the chat column and the pointers look: these were built from the
  mockup you picked (D30) and have not been seen running.
- How History and the deleted boards list look (mockup A, D31): seen only in a headless render of the page,
  never in the app. With a 12-hour clock a long sentence beside "Take back" wraps onto two or three lines.
- Anything that felt slow with both members on one board.
