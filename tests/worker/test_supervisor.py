import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from server.worker.job import JobResult
from server.worker.supervisor import READY_DELAY_SECONDS, StartupError, Supervisor, main


def request(op, **fields):
    value = {"schema_version": 1, "request_id": str(uuid.uuid4()), "operation": op}
    value.update(fields)
    return value


class SupervisorTests(unittest.TestCase):
    def _supervisor(self, root, **options):
        control = Path(root) / "control"
        inputs = Path(root) / "inputs"
        workspace = Path(root) / "workspace"
        for directory in (control, inputs, workspace):
            directory.mkdir(exist_ok=True)
        return Supervisor(
            str(control),
            str(inputs),
            str(workspace),
            str(Path(root) / "tmp"),
            ready_delay=0,
            exit_func=lambda code: None,
            enforce_identity=False,
            **options,
        )

    def test_synced_pre_step_records_the_manifest_before_the_command(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            calls = []

            def runner(operation, payload):
                calls.append(operation)
                return b'{"a.txt":["f",1,2,3,4,1]}'

            supervisor = self._supervisor(root, mode="synced", mirror_runner=runner)
            supervisor.post_step_done.wait(5)
            fields = dict(incarnation=supervisor.incarnation, job_id=str(uuid.uuid4()),
                          command="true", cwd=".", input_root=".", timeout_seconds=1)
            with patch("server.worker.supervisor.run_command",
                       return_value=JobResult("completed", 0, "", "", False)) as run:
                supervisor._run_current(fields)
            self.assertEqual(calls, ["apply"])
            self.assertEqual(run.call_args.kwargs["mode"], "synced")
            pending = json.loads(supervisor.sync_pending_path.read_text(encoding="utf-8"))
            self.assertEqual(pending["job_id"], fields["job_id"])
            self.assertEqual(pending["manifest"], {"a.txt": ["f", 1, 2, 3, 4, 1]})
            supervisor.close()

    def test_failed_pre_step_never_runs_the_command(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            def runner(operation, payload):
                raise OSError("helper failed")

            supervisor = self._supervisor(root, mode="synced", mirror_runner=runner)
            fields = dict(incarnation=supervisor.incarnation, job_id=str(uuid.uuid4()),
                          command="true", cwd=".", input_root=".", timeout_seconds=1)
            with patch("server.worker.supervisor.run_command") as run:
                supervisor._run_current(fields)
            run.assert_not_called()
            self.assertEqual(supervisor.previous_result, None)
            metadata = json.loads(supervisor.metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["result"]["reason"], "mirror_apply_failed")
            self.assertFalse(supervisor.sync_pending_path.exists())
            supervisor.close()

    def test_successor_collects_once_for_the_same_job_and_container_before_ready(self):
        for case in ("match", "other_job", "other_host"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(dir=".") as root:
                first = self._supervisor(root, mode="synced", mirror_runner=lambda *_: b"{}")
                first.post_step_done.wait(5)
                fields = dict(incarnation=first.incarnation, job_id=str(uuid.uuid4()),
                              command="true", cwd=".", input_root=".", timeout_seconds=1)
                with patch("server.worker.supervisor.run_command",
                           return_value=JobResult("completed", 0, "", "", False)):
                    first._run_current(fields)
                first.close()
                pending = json.loads(first.sync_pending_path.read_text(encoding="utf-8"))
                if case == "other_job":
                    pending["job_id"] = str(uuid.uuid4())
                if case == "other_host":
                    pending["host"] = "another-container"
                first.sync_pending_path.write_text(json.dumps(pending), encoding="utf-8")
                calls = []
                gate = __import__("threading").Event()

                def runner(operation, payload, calls=calls, gate=gate):
                    gate.wait(5)
                    calls.append((operation, json.loads(payload)))
                    return b"ok"

                second = self._supervisor(root, mode="synced", mirror_runner=runner)
                if case == "match":
                    self.assertEqual(second.handle_request(request("status"))["phase"], "starting")
                gate.set()
                second.post_step_done.wait(5)
                self.assertEqual(second.handle_request(request("status"))["phase"], "ready")
                expected = [("collect", {"manifest": {}, "job_id": fields["job_id"]})]
                self.assertEqual(calls, expected if case == "match" else [])
                self.assertFalse(second.sync_pending_path.exists())
                second.close()

    def test_copy_mode_never_runs_mirror_steps(self):
        with tempfile.TemporaryDirectory(dir=".") as root:
            def runner(*_):
                raise AssertionError("copy mode ran a mirror step")

            supervisor = self._supervisor(root, mirror_runner=runner)
            self.assertTrue(supervisor.post_step_done.is_set())
            fields = dict(incarnation=supervisor.incarnation, job_id=str(uuid.uuid4()),
                          command="true", cwd=".", input_root=".", timeout_seconds=1)
            with patch("server.worker.supervisor.run_command",
                       return_value=JobResult("completed", 0, "", "", False)) as run:
                supervisor._run_current(fields)
            self.assertEqual(run.call_args.kwargs["mode"], "copy")
            supervisor.close()

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

    def test_main_takes_a_bounded_ready_delay_before_touching_the_runtime(self):
        # Per-run desktop containers pass 0; the hosted long-lived worker keeps the default.
        for bad in (-1, READY_DELAY_SECONDS + 1, "0", None):
            runtime_patch = patch("server.worker.supervisor.validate_runtime")
            with self.subTest(bad=bad), runtime_patch as runtime:
                with self.assertRaises(SystemExit) as raised:
                    main(ready_delay=bad)
                self.assertEqual(raised.exception.code, 78)
                runtime.assert_not_called()
        with patch("server.worker.supervisor.validate_runtime", return_value="copy"), \
                patch("server.worker.supervisor.Supervisor") as built:
            main(ready_delay=0.0)
        built.assert_called_once_with(mode="copy", ready_delay=0.0)
        built.return_value.serve_forever.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
