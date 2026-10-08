"""Semantic catalog: a passive, bounded embedding index over knowledge folders.

Electron pumps ``catalog.index_step`` while the chat model is idle and owns the
embedder process and the folder registry; the sidecar owns the index (one
bounded SQLite file). See ``runtime.py`` for the process-level ownership note.
Kept import-light: ``sidecar.ai.memory.embedding`` imports ``vectors`` from here.
"""
