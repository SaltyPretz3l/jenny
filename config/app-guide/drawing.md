# Drawing diagrams

Jenny can answer with a drawing. Ask for a diagram and the chat draws it in the reply, in a hand-drawn style. This page explains how to ask, how to change a drawing, what you can do with one, and what the "Drawing instructions" setting does.

## What a sketch drawing is

A reply can hold a fenced code block tagged sketch. The chat reads the block, lays the drawing out for you and draws it. You never place anything by hand: the block says what the boxes and arrows are, and the chat decides where they go. A block without the sketch tag is just text, so nothing is drawn from it.

A small drawing looks like this in the reply:

```sketch
title Sign in
user User (person)
api API @server
db Accounts (cylinder)
user -> api password
api -> db look up
step Check: The API looks the user up | api db
```

Each line is one element. A box has an id, a label and, if you like, an icon or a shape. An arrow joins two boxes and can carry a short label. A dashed arrow and a two-way arrow are also possible. Boxes can sit inside a named group. A step has a title and some text, and it highlights the boxes it names, so a drawing can be read one step at a time.

## How to ask for one

Say what you want to see. For example:

- Draw how a sign-in request moves from the user to the database.
- Show me a diagram of how these three services talk to each other.
- Sketch the steps of a release.

Smaller drawings read better. The instructions ask the model for about 3 to 12 boxes, labels of 1 to 4 words and 3 to 7 steps. If you want more detail, ask for a second drawing of one part.

## Changing a drawing

To change a drawing, ask again. Say what to add, remove or rename. The model writes the whole block again and keeps the same ids, so the new drawing is the old one with your change in it.

The boxes both drawings share stay where they were, so you can see what changed. There is one exception: when the new drawing puts a new box before one that was already there, the chat lays the whole drawing out again, because that reads better. After Jenny restarts, an old drawing is laid out fresh and can look a little different.

## What you can do with a drawing

A drawing follows the app's theme. Under it there is a row of buttons:

- Open large: shows the drawing in a viewer that fills the window. Close returns you to the chat.
- Copy source: copies the sketch block's text.
- Export: saves the drawing as an SVG image, a PNG image or an Excalidraw drawing. You choose where the file goes.
- Mark up: lets you draw on the picture and then ask Jenny about your marks. Your question goes into the message box, so you can read and change it before you send it. "Attach the picture" sends the marked picture along. It is greyed out, with the reason, when the model you are using does not take pictures; then only your words are sent.

A drawing with steps can be read one step at a time, and each step highlights the boxes it is about.

A box can name a file. Click it and the file opens in the Workspace. This works only for a file inside the chat's own project folder. A file outside that folder, or one reached through a link, is not opened, and the chat says why. A chat with no project folder on this computer cannot open files from a drawing.

Nothing in a drawing is fetched from the internet, and drawing works offline.

## When part of a drawing is wrong

Small models sometimes write a line the chat cannot use: an arrow to a box that does not exist, the same name twice, a sentence where a box should be. The chat repairs or leaves out that line and draws the rest. A note under the drawing says how many problems there were, and you can open it to read them, each with its line number.

- Fix: puts the list of problems into the message box, with a request to write the block again. Nothing is sent until you send it.
- When too much of a block cannot be read, or the block is too large (more than 120 parts or 400 lines), the chat shows the source instead of a drawing and says why.
- Try again: appears when drawing took too long or failed. It draws the same block once more.

## The three choices

The setting is called Drawing instructions. You find it in Settings, on the Chat page, just below the switch for before and after pictures. It decides which diagram language the model is told about. The model is told about exactly one, never two.

- Short: the default. It teaches the sketch drawing described above. It is short on purpose, so it suits small local models.
- Full: it teaches the same drawing and adds more kinds of picture. Free pictures with shapes, lines, curves and ready-made objects. Ready-made shapes for timelines, cycles, pyramids, funnels, Venn diagrams, matrices and mind maps. Molecules written as a formula. Maps of countries and routes. It is a longer text, so it uses more of the model's context in every chat.
- Mermaid: it tells the model to write Mermaid in a fenced block tagged mermaid instead, as Jenny did before sketch drawings.

A Mermaid block in a reply still draws, whichever choice you make. The setting changes only what the model is told to write.

## When sketch drawings are turned off

Sketch drawings have a kill switch. Start Jenny with the environment variable JENNY_ENABLE_SKETCH_BLOCKS set to 0 and the model is told to write Mermaid, whatever the setting says. The Drawing instructions row stays in Settings but is greyed out, with the reason "Sketch drawings are turned off, so the model is told to write Mermaid." Your saved choice is kept and applies again when the switch is back on.

## If a drawing does not appear

- Check that the block is tagged sketch. Without the tag it stays plain text.
- Ask the model to draw it again with fewer boxes.
- Small models sometimes get a line wrong. Use Fix under the drawing, or ask them to write the whole block again.
- If the model keeps writing Mermaid, check that Drawing instructions is not set to Mermaid.
