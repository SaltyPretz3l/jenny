"""Conversation index: a derived, bounded search index over the user's past chats.

Electron owns canonical sessions and pushes their text through
``conversations.index_session``; the sidecar owns the derived SQLite file
(``conversation-index.db``) and answers ``conversations.search`` for the
``conversations_search`` tool. Lexical FTS5 always; vectors from the semantic
catalog's embedder while it is on. See ``runtime.py`` for the ownership note.
"""
