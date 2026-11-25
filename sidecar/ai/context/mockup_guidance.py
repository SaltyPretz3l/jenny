"""The system prompt line that teaches the mockup fence.

A mockup is one self-contained HTML page the model writes in a fenced code block tagged
``mockup`` in its reply; the chat shows it live in the sandboxed HTML frame. It is part of
the reply text, not a file, so it works in Plan Mode too. Always in the prompt, with or
without tools. A plain constant: the sidecar is frozen for packaging.
"""

from __future__ import annotations

MOCKUP_GUIDANCE = (
    "## Mockups\n"
    "To show what a screen, panel or other interface would look like, write one "
    "self-contained HTML page in a fenced code block tagged mockup in your reply; "
    "the chat shows it live. Put all CSS, SVG and script inline: the page cannot load "
    "files, fonts or anything from the network. Draw the real layout, colours and sizes, "
    "never text art. Use the real labels, keys, prices and wording: read them from the "
    "code first rather than inventing them. A mockup is part of your reply, not a file, "
    "so it works in Plan "
    "Mode too."
)
