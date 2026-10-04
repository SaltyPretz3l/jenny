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

    def test_subpath_copies_only_project_and_counts_subtree_limits(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            source, destination = Path(root) / "in", Path(root) / "out"
            (source / "a" / "nested").mkdir(parents=True)
            (source / "b").mkdir()
            (source / "a" / "nested" / "ok").write_bytes(b"ok")
            (source / "b" / "secret").write_bytes(b"secret" * 100)
            stats = snapshot_inputs(source, destination, subpath="a", max_bytes=2,
                                    max_files=2, max_depth=1)
            self.assertEqual((stats.files, stats.bytes), (1, 2))
            self.assertEqual(list(destination.iterdir()), [destination / "nested"])
            self.assertEqual((destination / "nested" / "ok").read_bytes(), b"ok")
            nested = Path(root) / "nested-out"
            snapshot_inputs(source, nested, subpath="a/nested", max_depth=0, max_files=1)
            self.assertEqual(list(nested.iterdir()), [nested / "ok"])
            with self.assertRaises(SnapshotLimit):
                snapshot_inputs(source, Path(root) / "limited", subpath="a", max_bytes=1)

    def test_missing_or_non_directory_subpath_fails(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            source = Path(root) / "in"
            source.mkdir()
            (source / "file").write_bytes(b"x")
            for subpath in ("missing", "file", "file/child"):
                with self.subTest(subpath=subpath), self.assertRaises(SnapshotError):
                    snapshot_inputs(source, Path(root) / "out", subpath=subpath)

    def test_symlinked_subpath_component_fails(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            source = Path(root) / "in"
            (source / "a" / "nested").mkdir(parents=True)
            try:
                (source / "link").symlink_to((source / "a").resolve(), target_is_directory=True)
                (source / "a" / "link").symlink_to((source / "a" / "nested").resolve(),
                                                  target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            for subpath in ("link", "link/nested", "a/link"):
                with self.subTest(subpath=subpath), self.assertRaises(SnapshotError):
                    snapshot_inputs(source, Path(root) / "out", subpath=subpath)


if __name__ == "__main__":
    unittest.main()
