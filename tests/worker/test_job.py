import os
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
