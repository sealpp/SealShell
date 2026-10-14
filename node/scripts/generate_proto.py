#!/usr/bin/env python3
"""Generate protobuf bindings with the uv-managed compiler on every platform."""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from google.protobuf import descriptor_pb2
from google.protobuf.compiler import plugin_pb2
from grpc_tools import protoc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    targets = parser.add_mutually_exclusive_group()
    targets.add_argument("--typescript", action="store_true", help="Generate Python and TypeScript")
    targets.add_argument("--typescript-only", action="store_true", help="Generate only TypeScript")
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    proto_path = root / "contracts"
    proto_file = "seal.proto"
    out_dir = root / "node" / "seal"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not (proto_path / proto_file).exists():
        print(f"Proto file not found: {proto_path / proto_file}", file=sys.stderr)
        return 1

    if not options.typescript_only:
        status = protoc.main([
            "protoc", f"--proto_path={proto_path}", f"--python_out={out_dir}", proto_file,
        ])
        if status:
            return status

    if options.typescript or options.typescript_only:
        # Use the standard plugin wire protocol directly. Windows cannot launch
        # an npm .cmd shim as a protoc plugin without an extra shell.
        with tempfile.TemporaryDirectory(prefix="seal-proto-") as temporary:
            descriptor = Path(temporary) / "seal.pb"
            status = protoc.main([
                "protoc", f"--proto_path={proto_path}", f"--descriptor_set_out={descriptor}",
                "--include_imports", "--include_source_info", proto_file,
            ])
            if status:
                return status
            descriptors = descriptor_pb2.FileDescriptorSet.FromString(descriptor.read_bytes())
        request = plugin_pb2.CodeGeneratorRequest(
            file_to_generate=[proto_file], parameter="target=ts", proto_file=descriptors.file,
        )
        shell = root / "shell"
        plugin = shell / "node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es"
        result = subprocess.run(
            ["node", str(plugin)], input=request.SerializeToString(), stdout=subprocess.PIPE,
            cwd=shell, check=True,
        )
        response = plugin_pb2.CodeGeneratorResponse.FromString(result.stdout)
        if response.error:
            print(response.error, file=sys.stderr)
            return 1
        for file in response.file:
            destination = shell / "src/proto" / file.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(file.content, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
