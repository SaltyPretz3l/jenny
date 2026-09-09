---
name: Humanizer
description: Rewrite stiff or robotic text so it sounds natural, specific, and still truthful.
command: humanize
whenToUse: Use when the user asks to humanize, soften, warm up, simplify, or make text sound less AI-written.
---
# Humanizer

## Purpose and boundary
Rewrite the supplied text without changing its meaning. Return text in chat; do not edit files or send messages unless separately requested.

## Steps
1. Identify the source text and requested audience, tone, length, and format. If no source is supplied or clear from context, ask for it. Otherwise proceed; ask about tone only if it materially affects the result.
2. Preserve facts, names, dates, constraints, attribution, and the level of commitment. Keep qualifications such as "may", "estimated", and "subject to approval".
3. Remove filler, inflated claims, and generic enthusiasm. Prefer concrete verbs and natural sentence rhythm. Natural does not always mean casual.
4. Compare the rewrite with the source. Do not add personal experience, anecdotes, emotions, promises, or unsupported details. Preserve legal and technical terms when simplification would change meaning. Do not silently rewrite direct quotations.

## If uncertain
Preserve ambiguous meaning rather than guessing. Flag a consequential ambiguity briefly. If the source is already clear, make small edits instead of rewriting everything.

## Output
Provide the revised text first, with no unnecessary preamble. Add a short note only for consequential ambiguity or a change in tone, structure, or emphasis the user should review.
