# Project boards

A board is a page inside a project where you lay out the project's work: notes, links, files, pictures, chats and diagrams. You place them where you want, join them with arrows and gather them into groups. The project's chat sits beside the board, so you can ask Jenny about what is on it. This page explains how to turn boards on, what goes on a board, the two ways to look at one, and how Jenny proposes changes.

## Turning boards on

Boards are on: the Board tab is in the top rail. There is no switch in Settings. To turn boards off, start Jenny with the environment variable JENNY_ENABLE_PROJECT_BOARDS set to 0; then there is no Board tab and nothing about boards is loaded.

## Boards and projects

A board belongs to one project, and a project can hold up to 20 boards. The Boards list on the Board tab shows them. From there you can make a new board, open, rename, duplicate, export or delete one, and add one from a file with "Import board".

Boards are saved on this computer in Jenny's own data folder, not in the project's folder. When a project is deleted, its boards move to General.

## What goes on a board

The toolbar above the board adds cards:

- Note: text you write, up to 4,000 characters. A note shows a little formatting: `**bold**`, `*italics*`, `` `code` ``, lines that start with `- ` or `1. ` as a list (two spaces of indent for a level), and web links: a label in square brackets followed by the address in round brackets, or the bare address. An address must start with http or https. Click a link to open it in your browser; hover to see where it goes. Nothing else is read as formatting, and a note never shows pictures or HTML. The Outline, find and exports show the note as you typed it.
- Link: a web address. Nothing is fetched unless you ask. "Fetch title" on a link card reads that one page's title.
- File: a file from the project's folder. Click the card to open the file in the Workspace. Only files inside the project's folder can be added. A card whose file is gone is marked as missing.
- Picture: a picture from a file. You can also paste or drop one. A picture can be up to 10 MB.
- Chat: a chat from this project. The card opens that chat.
- Diagram: a sketch drawing, as described on the drawing page. "Edit source" changes its text, "Open large" shows it in a viewer, and "Break apart" turns it into separate notes and arrows.

Two cards can be joined with an arrow, and the arrow can carry a short label. Selected cards can be put in a group with a title. Tidy arranges the selected group or cards in a grid. With nothing selected it arranges the whole board.

Undo and Redo cover every change, one step at a time.

A board holds at most 500 cards, 1,000 arrows and 50 groups. When a limit is reached the board says which one.

## Canvas and Outline

A board has two views, and both show the same board.

- Canvas: the cards as you placed them. To move around, hold the right mouse button and drag, or the middle button, or hold Space and drag, or turn the wheel. Ctrl with the wheel zooms.
- Outline: the same cards as a nested list, with each group as a branch and each card's arrows under it. Everything can be done from the keyboard here, and this is the view to use with a screen reader.

In the Outline the arrow keys, Home and End move between rows. Right opens a group and Left closes it. Typing a letter moves to the next row that starts with it. Space adds a row to the selection or takes it out, and Shift with an arrow key extends the selection. Enter or F2 edits a row in place, and Escape leaves the edit. Delete removes the selection. The menu key or Shift+F10 opens the row's menu. The Outline says what each action did, for example that a card was removed and that Undo is available.

## The chat beside the board

The Chat column on the Board tab shows a chat of this project. A message you send from there carries the board as text, so Jenny can read it. The cards you have selected are sent first and whole. The rest is shortened when the board is large. A small line under the message says "From a board", or the board's name once the Board tab has shown that board; click the name to open the board.

A message sent from the Chat page does not carry the board. If Jenny should see the board, send the message from the chat beside it.

"Ask Jenny" on the toolbar opens that chat for the cards you have selected.

The chat must belong to the board's project. If you pick a chat from another project, the board says so and asks you to pick or start one in this project.

## How Jenny changes a board

Jenny never changes a board on her own. When you ask her to, she writes a list of proposed changes, and you decide.

- In the chat, her list shows as one row: "Proposed 3 board changes". Show opens the lines she wrote.
- On the board, a bar says "Jenny proposes 3 changes" with three buttons. "Accept additions" adds every new card, group and arrow together, and one Undo takes them all back. Review opens the Changes view. Reject leaves everything out.
- The Changes view lists Additions, Edits and Removals apart. Every edit and every removal has its own button: Accept or Skip for an edit, Remove or Keep for a removal. Moving a card into a group, renaming a group and tidying are listed with the edits, because they change what is yours. Nothing is edited, moved or removed in bulk. The buttons stand at the end of each row, and "Accept additions" stands beside the Additions heading.
- New cards and groups show faintly on the canvas before you accept them, so you can see where they would go.
- A line Jenny wrote that cannot be used is shown crossed out with the reason, for example that it names a card that is not on the board. A proposal holds at most 40 lines.

Jenny can only rewrite a card she was shown whole. If she says she cannot, select the card and ask again.

With Full auto on for the chat, Jenny's additions are applied at once. The bar then says "Jenny made 3 changes." with Undo, for as long as that is the newest change on the board. Edits, moves, tidying and removals still wait for you, whatever the mode.

## Pin to board

You can put things from a chat onto a board with "Pin to board". It is offered on a message, a drawing, a picture, a file link and selected text in the side panel. Choose a board of the project, or New board. The pinned thing becomes a card, and a message that is already on a board says which one.

## Export and import

Export saves a board as one of five things. You choose where the file goes.

- Picture (PNG) and Drawing (SVG): the board as an image.
- Excalidraw file: the board as a drawing you can open in Excalidraw.
- Outline (Markdown): the board as text.
- Jenny board file (.jennyboard): the whole board, to keep or to move to another project or computer.

In the image and Excalidraw exports a diagram card shows as a box labelled Drawing, not as the drawing itself.

"Import board" reads a .jennyboard file and adds it as a new board. It is always a copy, so it never replaces a board you have.

## If something does not work

- There is no Board tab: boards are turned off. See "Turning boards on".
- "This board file is damaged" or "made by a newer version of Jenny": the board's file could not be read as a board, so Jenny shows nothing of it and leaves the file as it is. Two buttons stand under the sentence. Show file opens the folder that holds it. Remove from list takes the board out of the list and renames its file in the same folder (the new name ends in `.aside-` and a number); nothing is deleted, and its pictures are kept. To bring a board back, rename the file to what it was while Jenny is closed.
- Jenny's reply shows a code block tagged board and nothing is proposed: the message was not sent from the chat beside the board. Send it from there.
- A file card says its file is missing: the file was moved or deleted, or the project has no folder on this computer.
- "This project already has 20 boards": delete one to add another.
