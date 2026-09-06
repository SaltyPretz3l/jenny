#!/usr/bin/env python
"""Launch vLLM with a separate HF config identity and exact local weights.

vLLM 0.26.0 exposes ``ModelConfig.model_weights`` internally but omits it from
the ``vllm serve`` CLI.  Its pre-ModelConfig speculative check also tries to
decode a positional local GGUF as JSON before ``--hf-config-path`` is applied.
This test-only launcher keeps the public HF model as ``model`` and assigns the
exact local GGUF to vLLM's own ``model_weights`` field before starting its
ordinary OpenAI-compatible server.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

MAX_PORT = 65_535
MAX_MODEL_LEN = 8_192
MIN_GPU_MEMORY_UTILIZATION = 0.1
MAX_GPU_MEMORY_UTILIZATION = 0.9
MAX_CPU_OFFLOAD_GB = 6.0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-config", required=True)
    parser.add_argument("--model-weights", required=True)
    parser.add_argument("--served-model-name", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-model-len", type=int, default=8192)
    parser.add_argument("--gpu-memory-utilization", type=float, default=0.85)
    parser.add_argument("--cpu-offload-gb", type=float, default=6.0)
    return parser.parse_args(list(argv) if argv is not None else None)


def _validate(args: argparse.Namespace) -> Path:
    weights = Path(args.model_weights).expanduser()
    if not weights.is_absolute() or not weights.is_file():
        raise ValueError("--model-weights must be an existing absolute file")
    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("the W1-A vLLM evidence server must bind to localhost")
    if args.port < 1 or args.port > MAX_PORT:
        raise ValueError("--port is out of range")
    if args.max_model_len < 1 or args.max_model_len > MAX_MODEL_LEN:
        raise ValueError("--max-model-len must remain within the 8192-token evidence bound")
    if not MIN_GPU_MEMORY_UTILIZATION <= args.gpu_memory_utilization <= MAX_GPU_MEMORY_UTILIZATION:
        raise ValueError("--gpu-memory-utilization is outside the evidence bound")
    if not 0.0 <= args.cpu_offload_gb <= MAX_CPU_OFFLOAD_GB:
        raise ValueError("--cpu-offload-gb is outside the evidence bound")
    return weights.resolve()


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    weights = _validate(args)

    # These dependencies intentionally exist only inside the isolated WSL vLLM
    # environment, so importing them after validation keeps local unit tests light.
    import uvloop  # noqa: PLC0415
    from vllm.engine.arg_utils import AsyncEngineArgs  # noqa: PLC0415
    from vllm.entrypoints.cli.serve import ServeSubcommand  # noqa: PLC0415
    from vllm.entrypoints.openai.api_server import run_server  # noqa: PLC0415
    from vllm.entrypoints.openai.cli_args import make_arg_parser  # noqa: PLC0415
    from vllm.utils.argparse_utils import FlexibleArgumentParser  # noqa: PLC0415

    parser = make_arg_parser(FlexibleArgumentParser(add_help=False))
    serve_args = parser.parse_args(
        [
            "--model",
            args.model_config,
            "--tokenizer",
            args.tokenizer,
            "--hf-config-path",
            args.model_config,
            "--served-model-name",
            args.served_model_name,
            "--load-format",
            "gguf",
            "--max-model-len",
            str(args.max_model_len),
            "--gpu-memory-utilization",
            str(args.gpu_memory_utilization),
            "--cpu-offload-gb",
            str(args.cpu_offload_gb),
            "--enforce-eager",
            "--host",
            args.host,
            "--port",
            str(args.port),
        ]
    )
    serve_args.model_weights = str(weights)
    serve_args.model_tag = None

    # vLLM 0.20 carries ``model_weights`` through ModelConfig but its in-tree
    # GGUF loader still reads ``model``.  Preserve the HF identity until its
    # config has been resolved, then switch only the loader-facing reference.
    original_create_model_config = AsyncEngineArgs.create_model_config

    def create_model_config_with_exact_weights(engine_args: AsyncEngineArgs):
        model_config = original_create_model_config(engine_args)
        model_config.model = str(weights)
        model_config.model_weights = str(weights)
        return model_config

    AsyncEngineArgs.create_model_config = create_model_config_with_exact_weights
    ServeSubcommand().validate(serve_args)
    uvloop.run(run_server(serve_args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
