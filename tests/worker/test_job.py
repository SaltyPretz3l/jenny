import os
import tempfile
import unittest
from unittest.mock import patch

from server.worker import job
from server.worker.job import JobResult, _job_entry_code, run_command


class JobTests(unittest.TestCase):
    def test_fixed_helper_entrypoint_compiles(self):
        compile(_job_entry_code(), "<worker-helper>", "exec")

    @unittest.skipUnless(
        os.name == "posix" and os.geteuid() == 0 and os.getegid() == 10003,  # noqa: PLR2004
        "foreground helper proof needs the trusted supervisor capability set and input mount",
    )
    def test_foreground_command_and_output_bound(self):
        with tempfile.TemporaryDirectory() as root:
            result = run_command(
                "printf hello",
                ".",
                timeout_seconds=2,
                workspace_root=root,
                uid=os.getuid(),
                gid=os.getgid(),
            )
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.stdout, "hello")

    def test_result_record_is_wire_ready(self):
        result = JobResult("cancelled", None, "", "", False, "cancelled")
        record = result.record(
            "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"
        )
        self.assertEqual(record["status"], "cancelled")
        self.assertIsNone(record["exit_code"])

    def test_run_command_input_root_plumbing(self):
        if os.name != "posix":
            self.assertEqual(run_command("true", ".", input_root="a", timeout_seconds=1).reason,
                             "linux_required")
            return
        for root in (".", "projects/a"):
            with self.subTest(root=root), patch("server.worker.job.subprocess.Popen") as popen:
                popen.side_effect = OSError("no child")
                run_command("true", "nested", input_root=root, timeout_seconds=1, popen=popen)
                self.assertEqual(popen.call_args.args[0][-5:-1],
                                 ["true", "nested", root, "/workspace"])

    def test_job_entry_snapshots_input_root_and_uses_project_cwd(self):
        argv = ["helper", "true", "nested", "projects/a", "/workspace", "9"]
        self.assertEqual(job.JOB_ARG_COUNT, len(argv))
        with patch.object(os.sys, "argv", argv), patch.object(job, "resource") as resource_mock, \
             patch.object(job, "_verify_job_identity", return_value=True), \
             patch.object(job, "snapshot_inputs") as snapshot, \
             patch.object(os, "chdir") as chdir, patch.object(os, "set_inheritable"), \
             patch.object(os, "write"), patch.object(os, "close"), patch.object(os, "open"), \
             patch.object(os, "execve"), patch.object(os, "_exit", side_effect=RuntimeError):
            job.job_entry()
            snapshot.assert_called_once_with("/inputs", "/workspace", subpath="projects/a")
            chdir.assert_called_once_with(os.path.abspath("/workspace/nested"))
            self.assertTrue(resource_mock.setrlimit.called)


if __name__ == "__main__":
    unittest.main()
