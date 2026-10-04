import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from server.worker.job import JobResult
from server.worker.supervisor import StartupError, Supervisor


def request(op, **fields):
    value = {"schema_version": 1, "request_id": str(uuid.uuid4()), "operation": op}
    value.update(fields)
    return value


class SupervisorTests(unittest.TestCase):
    def _supervisor(self, root):
        control = Path(root) / "control"
        inputs = Path(root) / "inputs"
        workspace = Path(root) / "workspace"
        control.mkdir()
        inputs.mkdir()
        workspace.mkdir()
        return Supervisor(
            str(control),
            str(inputs),
            str(workspace),
            str(Path(root) / "tmp"),
            ready_delay=0,
            exit_func=lambda code: None,
            enforce_identity=False,
        )

    def test_cancel_before_admission_consumes_incarnation(self):
        with tempfile.TemporaryDirectory() as root:
            supervisor = self._supervisor(root)
            status = supervisor.handle_request(request("status"))
            incarnation = status["incarnation"]
            job_id = str(uuid.uuid4())
            result = supervisor.handle_request(
                request("cancel", incarnation=incarnation, job_id=job_id)
            )
            self.assertEqual(
                result,
                {
                    "schema_version": 1,
                    "request_id": result["request_id"],
                    "ok": True,
                    "accepted": True,
                },
            )
            metadata = (Path(root) / "control" / "worker-state.json").read_text(encoding="utf-8")
            self.assertIn("cancelled_before_admission", metadata)
            rejected = supervisor.handle_request(
                request(
                    "submit",
                    incarnation=incarnation,
                    job_id=str(uuid.uuid4()),
                    command="echo no",
                    cwd=".", input_root=".",
                    timeout_seconds=1,
                )
            )
            self.assertFalse(rejected["ok"])
            supervisor.close()

    def test_persistence_failure_exits_instead_of_returning_healthy_status(self):
        for operation in ("submit", "cancel"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as root:
                supervisor = self._supervisor(root)
                exits = []
                supervisor._exit_func = exits.append
                fields = {"incarnation": supervisor.incarnation, "job_id": str(uuid.uuid4())}
                if operation == "submit":
                    fields.update(
                        command="echo unreachable", cwd=".", input_root=".", timeout_seconds=1
                    )
                with patch("server.worker.supervisor._atomic_json",
                           side_effect=OSError("disk fault")):
                    with self.assertRaisesRegex(StartupError, "worker_persistence_failed"):
                        supervisor.handle_request(request(operation, **fields))
                self.assertEqual(exits, [1])
                self.assertEqual(supervisor.handle_request(request("status"))["phase"], "recycling")
                supervisor.close()

    def test_future_metadata_blocks_startup(self):
        with tempfile.TemporaryDirectory() as root:
            control = Path(root) / "control"
            control.mkdir()
            (control / "worker-state.json").write_text(
                '{"schema_version":99,"admission":null,"result":null}', encoding="utf-8"
            )
            with self.assertRaises(StartupError):
                Supervisor(
                    str(control),
                    str(Path(root) / "inputs"),
                    str(Path(root) / "workspace"),
                    str(Path(root) / "tmp"),
                    ready_delay=0,
                    exit_func=lambda code: None,
                    enforce_identity=False,
                )

    def test_admission_carries_input_root_and_retry_must_match(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            supervisor = self._supervisor(root)
            fields = dict(incarnation=supervisor.incarnation, job_id=str(uuid.uuid4()),
                          command="true", cwd="nested", input_root="projects/a", timeout_seconds=1)
            with patch("server.worker.supervisor.threading.Thread"):
                self.assertTrue(supervisor.handle_request(request("submit", **fields))["ok"])
                metadata = json.loads(supervisor.metadata_path.read_text(encoding="utf-8"))
                self.assertEqual(metadata["admission"], fields)
                self.assertTrue(supervisor.handle_request(request("submit", **fields))["ok"])
                rejected = supervisor.handle_request(
                    request("submit", **{**fields, "input_root": "b"})
                )
                self.assertEqual(rejected["error"], "job_already_admitted")
            with patch("server.worker.supervisor.run_command",
                       return_value=JobResult("completed", 0, "", "", False)) as run:
                supervisor._run_current(fields)
                self.assertEqual(run.call_args.args, ("true", "nested"))
                self.assertEqual(run.call_args.kwargs["input_root"], "projects/a")
            supervisor.close()

    def test_old_and_current_admissions_restart_interrupted_but_unknown_keys_fail(self):
        for shape in ("old", "current", "unknown"):
            with self.subTest(shape=shape), tempfile.TemporaryDirectory(dir=".") as root:
                supervisor = self._supervisor(root)
                fields = dict(incarnation=supervisor.incarnation, job_id=str(uuid.uuid4()),
                              command="never replay", cwd=".", timeout_seconds=1)
                if shape != "old":
                    fields["input_root"] = "projects/a"
                if shape == "unknown":
                    fields["extra"] = True
                supervisor._persist(fields, None)
                supervisor.close()
                with patch("server.worker.supervisor.run_command") as run:
                    if shape == "unknown":
                        with self.assertRaisesRegex(StartupError, "corrupt worker admission"):
                            supervisor._load_metadata()
                    else:
                        supervisor._load_metadata()
                        self.assertEqual(supervisor.previous_result["status"], "interrupted")
                        self.assertEqual(supervisor.previous_result["job_id"], fields["job_id"])
                    run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
