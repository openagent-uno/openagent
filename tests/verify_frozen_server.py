"""Qualify an installed frozen server using disposable data and bundled assets.

Run with the qualification Python environment (MCP SDK is test-only). The
server subprocess receives an empty PATH and a fresh HOME; it cannot resolve
an external Python or Node runtime. No provider or voice model is downloaded.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import tempfile
import threading
import time


async def verify_mcp(binary: Path, extracted: Path, root: Path, environment: dict) -> dict:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    node = extracted / "node"
    assert node.is_file(), "The frozen server omitted its Node runtime"
    version = subprocess.check_output([str(node), "--version"], env=environment, text=True).strip()
    assets = extracted / "openagent_modules/resources/vault"
    manifest = json.loads((assets / "manifest.json").read_text())
    for item in manifest["artifacts"]:
        data = (assets / item["file"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item["sha256"]
    vault = root / "vault-probe"
    vault.mkdir()
    params = StdioServerParameters(command=str(node), args=[str(assets / "dist/server.mjs")],
        cwd=str(root), env=dict(environment, OPENAGENT_VAULT_PATH=str(vault),
            OPENAGENT_VAULT_VALIDATE_WRITES="1"))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            names = {tool.name for tool in (await client.list_tools()).tools}
            assert {"write_note", "patch_note", "read_note"} <= names
            result = await client.call_tool("write_note", {"path": "Concepts/frozen.md",
                "content": "# Frozen runtime\n\nThe standalone vault uses bundled assets.\n"})
            assert not result.isError, result
            content = (vault / "Concepts/frozen.md").read_text()
            assert content.startswith("---\n") and "created:" in content
            failed = await client.call_tool("patch_note", {"path": "Concepts/frozen.md",
                "oldString": "absent text", "newString": "changed"})
            assert failed.isError
            assert (vault / "Concepts/frozen.md").read_text() == content
            read_result = await client.call_tool("read_note", {"path": "Concepts/frozen.md"})
            assert "bundled assets" in read_result.content[0].text

    params = StdioServerParameters(command=str(binary), args=["_mcp-server", "budget-manager"],
        cwd=str(root), env=dict(environment, OPENAGENT_DB_PATH=str(root / "mcp-probe.db")))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            python_tools = sorted(tool.name for tool in (await client.list_tools()).tools)
            assert python_tools, "The frozen Python MCP module exposed no tools"
    return {"node_version": version, "vault_tool_count": len(names),
        "vault_write_read": True, "failed_patch_preserves_note": True,
        "vault_artifact_hashes_match": True, "python_mcp_tools": python_tools}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    args.evidence.mkdir(parents=True, exist_ok=True)
    receipt = {"binary": str(binary), "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "signing": "not assessed by this runtime test", "commands": []}
    with tempfile.TemporaryDirectory(prefix="openagent-frozen-qualification-", dir="/tmp") as temporary:
        root = Path(temporary)
        home, tmp, empty_bin, agent = (root / name for name in ("home", "tmp", "empty-bin", "agent"))
        for directory in (home, tmp, empty_bin, agent):
            directory.mkdir()
        environment = {"HOME": str(home), "TMPDIR": str(tmp), "PATH": str(empty_bin),
            "USERPROFILE": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
            "LITELLM_LOCAL_MODEL_COST_MAP": "True", "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1", "OPENAGENT_IROH_DISCOVERY": "none",
            "OPENAGENT_HOST_TOOLS_HOME": str(root / "host-tools"), "NO_COLOR": "1",
            "TERM": "dumb", "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"}
        for label, command, expected in (
            ("version", ["--version"], "1.0.0b1"),
            ("help", ["--help"], "serve"),
            ("selfcheck", ["selfcheck", "--quiet", "--expect", "1.0.0b1"], "1.0.0b1"),
        ):
            started = time.monotonic()
            result = subprocess.run([str(binary), *command], cwd=root, env=environment,
                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
            (args.evidence / f"frozen-server-{label}.log").write_text(result.stdout)
            assert result.returncode == 0, f"{label}: {result.stdout}"
            assert expected in result.stdout
            receipt["commands"].append({"command": command, "exit_code": result.returncode,
                "seconds": round(time.monotonic() - started, 3)})
            print(f"{label}: PASS", flush=True)

        audio = subprocess.run([str(binary), "_audio-worker"], input='{"row":{},"operation":"synthesize"}',
            cwd=root, env=environment, text=True, capture_output=True, timeout=60)
        assert audio.returncode == 0 and json.loads(audio.stdout) == {"error":"audio_provider_unavailable"}
        assert not list(agent.iterdir()), "Audio worker unexpectedly bootstrapped an agent"
        receipt["audio_worker"] = {"early_entry": True, "missing_route_rejected": True}

        config = agent / "openagent.yaml"
        config.write_text(json.dumps({"name": "frozen-fixture", "local_e2e_fixture": True,
            "voice": {"prefetch": False}, "memory": {"db_path": str(agent / "memory.db")},
            "channels": {}}))
        lines: list[str] = []
        ready = queue.Queue()
        process = subprocess.Popen([str(binary), "-d", str(agent), "serve", "--local-e2e", "--channel", "gateway"],
            cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, start_new_session=True)

        def drain() -> None:
            for line in process.stdout:
                lines.append(line)
                if "Serving" in line and "gateway:iroh@" in line:
                    ready.put(True)
            ready.put(False)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            assert ready.get(timeout=90), "Frozen server exited before its Iroh gateway was ready"
            extracted = list(tmp.glob("_MEI*"))
            assert len(extracted) == 1, extracted
            receipt["mcp"] = asyncio.run(verify_mcp(binary, extracted[0], root, environment))
            receipt["runtime"] = {"gateway_started": True, "external_runtime_path": False,
                "voice_models_downloaded": bool(list(home.rglob("*.safetensors")))}
            assert not receipt["runtime"]["voice_models_downloaded"]
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=10)
            reader.join(timeout=2)
            (args.evidence / "frozen-server-serve.log").write_text("".join(lines))
        assert process.returncode == 0, f"Server shutdown: {process.returncode}"
        assert not list(tmp.glob("_MEI*")), "Frozen extraction directory leaked after shutdown"
        receipt["runtime"]["shutdown_exit_code"] = process.returncode
        receipt["runtime"]["extraction_cleaned"] = True
    (args.evidence / "frozen-server-verification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
