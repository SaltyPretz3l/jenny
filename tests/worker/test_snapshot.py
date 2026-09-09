import os
import tempfile
import unittest
from pathlib import Path

from server.worker.snapshot import SnapshotError, SnapshotLimit, snapshot_inputs


class SnapshotTests(unittest.TestCase):
    def test_copies_regular_tree_with_limits(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / "in", Path(root) / "out"
            source.mkdir()
            (source / "nested").mkdir()
            (source / "a.txt").write_text("a", encoding="utf-8")
            (source / "nested" / "b.txt").write_text("b", encoding="utf-8")
            stats = snapshot_inputs(source, destination)
            self.assertEqual((stats.files, stats.bytes), (2, 2))
            self.assertEqual((destination / "nested" / "b.txt").read_text(encoding="utf-8"), "b")

    def test_rejects_symlink_and_budget(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / "in", Path(root) / "out"
            source.mkdir()
            (source / "ok").write_text("ok", encoding="utf-8")
            try:
                (source / "link").symlink_to(source / "ok")
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            with self.assertRaises(SnapshotError):
                snapshot_inputs(source, destination)
            (source / "link").unlink()
            with self.assertRaises(SnapshotLimit):
                snapshot_inputs(source, Path(root) / "out2", max_bytes=1)

    def test_rejects_hardlink(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / "in", Path(root) / "out"
            source.mkdir()
            (source / "one").write_text("one", encoding="utf-8")
            try:
                os.link(source / "one", source / "two")
            except OSError:
                self.skipTest("hardlinks unavailable")
            with self.assertRaises(SnapshotError):
                snapshot_inputs(source, destination)


if __name__ == "__main__":
    unittest.main()
