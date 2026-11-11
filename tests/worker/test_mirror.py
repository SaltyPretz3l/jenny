import hashlib
import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server.worker import mirror
from server.worker.mirror import MirrorError, apply_delta, collect, fold, manifest

JOB = "11111111-2222-4333-8444-555555555555"
PROTECTED = {"names": [".git", ".jenny", ".husky", "node_modules", ".venv", "venv"],
             "paths": ["tools/hooks"]}


def stage(inputs: Path, files: dict[str, str], **fields) -> None:
    (inputs / "files").mkdir(parents=True, exist_ok=True)
    listed = []
    for number, (relative, text) in enumerate(files.items()):
        (inputs / "files" / str(number)).write_text(text, encoding="utf-8")
        listed.append([relative, str(number), len(text.encode()),
                       hashlib.sha256(text.encode()).hexdigest()])
    sync = {"schema_version": 1, "full": False, "directories": [], "files": listed, "deletes": [],
            "trees": [], "protected": PROTECTED, **fields}
    (inputs / "sync.json").write_text(json.dumps(sync), encoding="utf-8")


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        base = Path(self._dir.name)
        self.inputs, self.workspace, self.outbox = base / "inputs", base / "ws", base / "out"
        for directory in (self.inputs, self.workspace, self.outbox):
            directory.mkdir()

    def tearDown(self):
        self._dir.cleanup()

    def test_fold_matches_the_host_rules(self):
        self.assertEqual(fold(".GIT"), ".git")
        self.assertEqual(fold(".gıt"), ".git")
        self.assertEqual(fold(".git. "), ".git")

    def test_full_sync_wipes_then_delta_creates_replaces_and_deletes(self):
        (self.workspace / "stale.txt").write_text("old", encoding="utf-8")
        stage(self.inputs, {"a.txt": "alpha", "src/b.js": "beta"}, full=True,
              directories=["empty"])
        apply_delta(str(self.inputs), str(self.workspace))
        self.assertEqual(sorted(os.listdir(self.workspace)), ["a.txt", "empty", "src"])
        self.assertEqual((self.workspace / "src" / "b.js").read_text(encoding="utf-8"), "beta")

        for name in ("files", "sync.json"):
            mirror.remove(str(self.inputs / name))
        (self.workspace / "src" / "b.js").write_text("edited in mirror", encoding="utf-8")
        (self.workspace / "dir").mkdir()
        (self.workspace / "dir" / "inner").write_text("x", encoding="utf-8")
        stage(self.inputs, {"src/b.js": "beta two", "dir": "now a file"}, deletes=["a.txt"],
              trees=["empty"])
        apply_delta(str(self.inputs), str(self.workspace))
        self.assertEqual(sorted(os.listdir(self.workspace)), ["dir", "src"])
        self.assertEqual((self.workspace / "src" / "b.js").read_text(encoding="utf-8"), "beta two")
        self.assertEqual((self.workspace / "dir").read_text(encoding="utf-8"), "now a file")

    @unittest.skipUnless(os.name == "posix", "mirror symlinks exist only in the Linux volume")
    def test_a_link_left_by_an_earlier_command_is_replaced_never_written_through(self):
        outside = Path(self._dir.name) / "outside"
        outside.mkdir()
        os.symlink(outside, self.workspace / "src")
        os.symlink(outside / "target.txt", self.workspace / "a.txt")
        stage(self.inputs, {"src/b.js": "beta", "a.txt": "alpha"}, deletes=["src/gone.txt"])
        apply_delta(str(self.inputs), str(self.workspace))
        self.assertEqual(os.listdir(outside), [])
        self.assertFalse((self.workspace / "src").is_symlink())
        self.assertFalse((self.workspace / "a.txt").is_symlink())

    def test_unsafe_delta_paths_are_refused(self):
        for bad in ("../escape", "/abs", "a/../b", ""):
            with self.subTest(bad=bad):
                stage(self.inputs, {}, deletes=[bad])
                with self.assertRaises(MirrorError):
                    apply_delta(str(self.inputs), str(self.workspace))

    def _collect(self, before):
        return collect(str(self.workspace), str(self.outbox), before, JOB, PROTECTED)

    def test_collect_reports_added_modified_deleted_and_copies_only_regular_files(self):
        (self.workspace / "keep.txt").write_text("keep", encoding="utf-8")
        (self.workspace / "edit.txt").write_text("before", encoding="utf-8")
        (self.workspace / "gone.txt").write_text("bye", encoding="utf-8")
        before = manifest(str(self.workspace))
        (self.outbox / "planted").write_text("left by someone", encoding="utf-8")
        (self.workspace / "edit.txt").write_text("after!", encoding="utf-8")
        (self.workspace / "gone.txt").unlink()
        (self.workspace / "new").mkdir()
        (self.workspace / "new" / "file.txt").write_text("fresh", encoding="utf-8")
        (self.workspace / ".GIT").mkdir()
        (self.workspace / ".GIT" / "config").write_text("[core]", encoding="utf-8")
        (self.workspace / "tools" / "hooks").mkdir(parents=True)
        (self.workspace / "tools" / "hooks" / "pre-commit").write_text("x", encoding="utf-8")
        record = self._collect(before)
        self.assertEqual(record["status"], "ok")
        by_path = {entry["path"]: entry for entry in record["entries"]}
        self.assertEqual(by_path["edit.txt"]["change"], "modified")
        self.assertEqual(by_path["gone.txt"], {"path": "gone.txt", "change": "deleted",
                                                "kind": "file"})
        self.assertEqual(by_path["new"]["kind"], "directory")
        self.assertEqual(by_path[".GIT"]["refused"], "protected")
        self.assertEqual(by_path["tools/hooks"]["refused"], "protected")
        self.assertNotIn(".GIT/config", by_path)
        self.assertNotIn("keep.txt", by_path)
        added = by_path["new/file.txt"]
        copied = (self.outbox / "files" / added["file"]).read_bytes()
        self.assertEqual(copied, b"fresh")
        self.assertEqual(added["sha256"], hashlib.sha256(b"fresh").hexdigest())
        self.assertFalse((self.outbox / "planted").exists())
        on_disk = json.loads((self.outbox / "changes.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, record)

    @unittest.skipUnless(os.name == "posix", "symlink and hardlink refusals need the Linux volume")
    def test_collect_refuses_links_and_hardlinks(self):
        before = manifest(str(self.workspace))
        os.symlink("/etc/passwd", self.workspace / "link")
        (self.workspace / "a").write_text("a", encoding="utf-8")
        os.link(self.workspace / "a", self.workspace / "b")
        os.mkfifo(self.workspace / "fifo")
        entries = self._collect(before)["entries"]
        reasons = {entry["path"]: entry.get("refused") for entry in entries}
        self.assertEqual(reasons, {"link": "symlink", "a": "hardlink", "b": "hardlink",
                                   "fifo": "special"})
        self.assertFalse((self.outbox / "files" / "0").exists())

    def test_over_cap_changes_write_back_nothing(self):
        before = manifest(str(self.workspace))
        for index in range(4):
            (self.workspace / f"f{index}").write_text("x", encoding="utf-8")
        with patch.object(mirror, "OUTBOX_MAX_ENTRIES", 3):
            record = self._collect(before)
        self.assertEqual(record, {"schema_version": 1, "job_id": JOB,
                                  "status": "write_back_too_large", "entries": []})
        self.assertFalse((self.outbox / "files").exists())

    def test_trees_deeper_than_the_recursion_limit_are_walked_and_removed(self):
        deep = self.workspace
        for _ in range(80):
            deep = deep / "d"
        deep.mkdir(parents=True)
        (deep / "leaf.txt").write_text("x", encoding="utf-8")
        limit = sys.getrecursionlimit()
        sys.setrecursionlimit(len(inspect.stack()) + 40)
        try:
            listed = manifest(str(self.workspace))
            mirror.remove(str(self.workspace / "d"))
        finally:
            sys.setrecursionlimit(limit)
        self.assertEqual(len(listed), 81)
        self.assertFalse((self.workspace / "d").exists())

    @unittest.skipUnless(os.name == "posix" and os.geteuid() != 0, "needs a non-root POSIX user")
    def test_an_unreadable_file_is_refused_without_losing_the_other_changes(self):
        before = manifest(str(self.workspace))
        (self.workspace / "ok.txt").write_text("fine", encoding="utf-8")
        (self.workspace / "locked").write_text("secret", encoding="utf-8")
        os.chmod(self.workspace / "locked", 0)
        record = self._collect(before)
        reasons = {entry["path"]: entry.get("refused") for entry in record["entries"]}
        self.assertEqual(record["status"], "ok")
        self.assertEqual(reasons, {"locked": "unreadable", "ok.txt": None})


if __name__ == "__main__":
    unittest.main()
