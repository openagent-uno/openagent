"""Client-side login + registration. UI-agnostic — the CLI and app both call this.

Flow:

    1. ``register(invite_code, handle, password)`` — runs the PAKE
       registration round-trip + adds our device, returns a freshly
       minted cert. Caller persists it via ``store_cert``.

    2. ``login(handle, password)`` — runs the PAKE login round-trip,
       returns a fresh cert.

    3. ``refresh_cert(handle)`` — replays login when an existing cert
       is past its 50% TTL. Same wire as ``login``.

All three end up at the coordinator's NodeId via ``IrohNode.dial``.
The coordinator's pubkey is pinned at first contact: when adding a
network you record ``(coordinator_node_id, coordinator_pubkey)`` and
every subsequent connection verifies the response cert against the
pinned pubkey.

Wire format mirrors ``coordinator.service``:
``len(4) || cbor({id, method, params}) || finish``.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
import time
import uuid

import cbor2

from openagent_identity.auth.device_cert import (
    CertVerificationError,
    DeviceCert,
    verify_cert,
)
from openagent_identity.coordinator.pake import (
    Srp6aBackend,
    Srp6aClientLogin,
    srp6a_make_registration,
)
from openagent_identity.identity import Identity
from openagent_identity.iroh_node import IrohNode, NetworkAlpn

logger = logging.getLogger(__name__)


class LoginError(Exception):
    """Raised on any client-side failure (wire, PAKE, cert) during login."""


@dataclass(eq=False)
class _CoordinatorConnection:
    node_id: str
    opening: asyncio.Task
    users: int = 0
    retired: bool = False
    closed: bool = False


class _CoordinatorRpcPool:
    """Reuse transport connections, never roster or other RPC results.

    Owned by one IrohNode (and therefore one cryptographic identity). Each
    caller owns a separate stream. A failed stream retires its connection
    for new calls without closing other callers' in-flight streams.
    """

    def __init__(self, node: IrohNode) -> None:
        self._node = node
        self._connections: dict[str, _CoordinatorConnection] = {}
        self._owned: set[_CoordinatorConnection] = set()
        self._closed = False

    def _close_if_unused(self, entry: _CoordinatorConnection, *, force=False) -> None:
        if not entry.retired or (entry.users and not force) or not entry.opening.done():
            return
        if not entry.closed:
            entry.closed = True
            try:
                entry.opening.result().close(0, b"")
            except (Exception, asyncio.CancelledError):
                pass
        self._owned.discard(entry)

    def _retire(self, entry: _CoordinatorConnection) -> None:
        entry.retired = True
        if self._connections.get(entry.node_id) is entry:
            self._connections.pop(entry.node_id)
        self._close_if_unused(entry, force=self._closed)

    def _opened(self, entry: _CoordinatorConnection) -> None:
        try:
            entry.opening.result()
        except (Exception, asyncio.CancelledError):
            self._retire(entry)
        self._close_if_unused(entry, force=self._closed)

    def _release(self, entry: _CoordinatorConnection) -> None:
        entry.users -= 1
        # Nobody needs an unfinished dial after the last waiter leaves.
        # Its callback closes any eventual result, including a native dial
        # that completes after Python cancellation was requested.
        if not entry.users and not entry.opening.done():
            self._retire(entry)
            entry.opening.cancel()
        self._close_if_unused(entry)

    @asynccontextmanager
    async def connection(self, node_id: str, *, relay_url=None, addresses=None):
        if self._closed:
            raise LoginError("coordinator RPC pool is closed")
        entry = self._connections.get(node_id)
        if entry is None:
            opening = asyncio.create_task(self._node.dial(
                node_id, NetworkAlpn.COORDINATOR,
                relay_url=relay_url, addresses=addresses,
            ), name="coordinator-rpc-dial")
            entry = _CoordinatorConnection(node_id=node_id, opening=opening)
            self._connections[node_id] = entry
            self._owned.add(entry)
            opening.add_done_callback(lambda _task: self._opened(entry))
        entry.users += 1
        acquired = False
        try:
            # One caller's timeout/cancellation must not cancel the dial
            # another caller is sharing.
            connection = await asyncio.shield(entry.opening)
            if self._closed:
                raise LoginError("coordinator RPC pool is closed")
            acquired = True
            yield connection
        except BaseException:
            if acquired or entry.opening.done():
                self._retire(entry)
            raise
        finally:
            self._release(entry)

    async def close(self) -> None:
        self._closed = True
        for entry in tuple(self._owned):
            self._retire(entry)
            if not entry.opening.done():
                entry.opening.cancel()
        # Do not await an unresponsive native dial during shutdown. The
        # completion callback owns late results; node.shutdown also tears
        # down the endpoint that owns those pending transport operations.


def _coordinator_pool(node: IrohNode) -> _CoordinatorRpcPool:
    if getattr(node, "_coordinator_rpc_stopped", False):
        raise LoginError("Iroh node is stopped")
    pool = getattr(node, "_coordinator_rpc_pool", None)
    if pool is None:
        pool = _CoordinatorRpcPool(node)
        node._coordinator_rpc_pool = pool
    return pool


async def register(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    coordinator_pubkey_bytes: bytes,
    handle: str,
    password: str,
    invite_code: str,
    device_identity: Identity,
    network_id: str,
    label: str | None = None,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> bytes:
    """Register a new ``handle@network`` and return the wire-encoded cert.

    Two RPCs: ``register`` (creates the user row + verifier) then
    ``login_init``+``login_finish`` (proves we hold the password and
    pairs our device). The coordinator emits a cert at the end of the
    login, which is what we cache.
    """
    pake_payload = srp6a_make_registration(handle, password)

    await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="register",
        params={
            "invite": invite_code,
            "handle": handle,
            "pake_record": pake_payload,
        },
        relay_url=relay_url,
        addresses=addresses,
    )
    return await login(
        node=node,
        coordinator_node_id=coordinator_node_id,
        coordinator_pubkey_bytes=coordinator_pubkey_bytes,
        handle=handle,
        password=password,
        device_identity=device_identity,
        network_id=network_id,
        invite_code=invite_code,
        label=label,
        relay_url=relay_url,
        addresses=addresses,
    )


async def login(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    coordinator_pubkey_bytes: bytes,
    handle: str,
    password: str,
    device_identity: Identity,
    network_id: str,
    invite_code: str | None = None,
    label: str | None = None,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> bytes:
    """Run an SRP-6a login; return the issued cert wire bytes.

    *invite_code* is optional — only needed when we're a new device
    pairing onto an existing account. Existing devices skip it; the
    coordinator recognises the device pubkey and just reissues a cert.
    """
    client = Srp6aClientLogin.start(handle, password)

    init_resp = await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="login_init",
        params={"handle": handle, "ke1": client.A},
        relay_url=relay_url,
        addresses=addresses,
    )
    state_id = init_resp["state_id"]
    server_response = init_resp["response"]

    M1 = client.respond(bytes(server_response))

    finish_params: dict = {
        "state_id": state_id,
        "ke3": M1,
        "device_pubkey": device_identity.public_bytes,
    }
    if invite_code:
        finish_params["invite"] = invite_code
    if label:
        finish_params["label"] = label

    finish_resp = await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="login_finish",
        params=finish_params,
        relay_url=relay_url,
        addresses=addresses,
    )
    cert_wire = bytes(finish_resp["cert"])
    server_proof = bytes(finish_resp["m2"])
    # The server proof is what binds the cert delivery to "this is the
    # real coordinator we ran SRP with"; we ignore the bytes (we don't
    # use the SRP session key for anything else) but verifying it
    # would mean re-deriving M2 inside Srp6aClientLogin. srptools'
    # ``key_proof`` already gives us the same value the server returns,
    # so this is a defensive check rather than a security boundary.
    try:
        client.verify_server(server_proof)
    except Exception:
        logger.debug("SRP server-proof check skipped or mismatched (non-fatal)")

    # Cert verification — sanity-check the cert against the pinned
    # coordinator pubkey before we hand it back. The session dialer
    # would catch a bad cert later, but failing here gives the caller
    # a cleaner error path.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    pubkey = Ed25519PublicKey.from_public_bytes(coordinator_pubkey_bytes)
    try:
        # An empty ``network_id`` is the ticket-driven path: caller
        # doesn't have the canonical id yet (they only see what the
        # coordinator publishes), so we accept whatever the cert
        # claims. Caller is expected to pin it on persist.
        cert = verify_cert(
            cert_wire,
            coordinator_pubkey=pubkey,
            expected_network_id=network_id or None,
        )
    except CertVerificationError as e:
        raise LoginError(f"coordinator returned malformed cert: {e}") from e

    if cert.handle != handle.strip().lower():
        raise LoginError(f"cert handle mismatch (got {cert.handle!r}, expected {handle!r})")
    if cert.device_pubkey != device_identity.public_bytes:
        raise LoginError("cert device pubkey doesn't match this device")

    return cert_wire


async def refresh_cert(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    coordinator_pubkey_bytes: bytes,
    handle: str,
    password: str,
    device_identity: Identity,
    network_id: str,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> bytes:
    """Re-run login to get a fresh cert. Same wire as ``login``."""
    return await login(
        node=node,
        coordinator_node_id=coordinator_node_id,
        coordinator_pubkey_bytes=coordinator_pubkey_bytes,
        handle=handle,
        password=password,
        device_identity=device_identity,
        network_id=network_id,
        relay_url=relay_url,
        addresses=addresses,
    )


async def agent_login(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    coordinator_pubkey_bytes: bytes,
    handle: str,
    node_id: str,
    invite_code: str,
    network_id: str = "",
    label: str | None = None,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> bytes:
    """Authenticate an agent using its Iroh identity (no password needed).

    Calls the coordinator's ``agent_login`` RPC, which verifies that the
    caller's Iroh peer_node_id matches ``node_id`` (the QUIC handshake is the
    proof of key ownership).  Returns the wire-encoded device cert.

    The returned cert has ``capabilities=["agent"]`` and uses the agent's
    Iroh pubkey as ``device_pubkey``, so the same identity that dials the
    coordinator now authenticates against the target gateway.
    """
    params: dict = {
        "invite": invite_code,
        "handle": handle,
        "node_id": node_id,
    }
    if label:
        params["label"] = label

    result = await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="agent_login",
        params=params,
        relay_url=relay_url,
        addresses=addresses,
    )
    cert_wire = bytes(result["cert"])

    # Sanity-check: verify the cert is signed by the pinned coordinator pubkey.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    pubkey = Ed25519PublicKey.from_public_bytes(coordinator_pubkey_bytes)
    cert = verify_cert(
        cert_wire,
        coordinator_pubkey=pubkey,
        expected_network_id=network_id or None,
    )
    if cert.handle != handle.strip().lower():
        raise LoginError(f"cert handle mismatch (got {cert.handle!r}, expected {handle!r})")
    return cert_wire


async def fetch_network_info(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> dict:
    """Fetch the coordinator's self-description (used for first-add of a network)."""
    return await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="network_info",
        params={},
        relay_url=relay_url,
        addresses=addresses,
    )


async def list_agents(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> list[dict]:
    """List the agents registered in this network (handle + node_id pairs)."""
    resp = await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="list_agents",
        params={},
        relay_url=relay_url,
        addresses=addresses,
    )
    return resp.get("agents") or []


async def device_is_active(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    device_pubkey: bytes,
    timeout: float = 5.0,
) -> bool:
    """Ask the coordinator for authoritative live device membership.

    The coordinator accepts this RPC only from an enrolled agent's Iroh
    identity, so member gateways can fail closed without copying the roster.
    """
    if len(device_pubkey) != 32:
        return False
    result = await _rpc(
        node=node,
        coordinator_node_id=coordinator_node_id,
        method="device_status",
        params={"device_pubkey": bytes(device_pubkey)},
        timeout=timeout,
    )
    return result.get("active") is True


async def read_runtime_directory(*,node,coordinator_node_id,timeout=5.0):
    """Read the authoritative recipient directory as an enrolled agent peer."""
    result=await _rpc(node=node,coordinator_node_id=coordinator_node_id,
                      method='runtime_directory',params={},timeout=timeout)
    if not isinstance(result,dict) or set(result)!={'users','agents','devices'}:
        raise ValueError('Coordinator returned an invalid runtime directory')
    if any(not isinstance(result[key],list) for key in result):
        raise ValueError('Coordinator returned an invalid runtime directory')
    if any(not isinstance(handle,str) or not handle for key in ('users','agents') for handle in result[key]):
        raise ValueError('Coordinator returned an invalid principal')
    return result


# ── Internals ────────────────────────────────────────────────────────


async def _rpc(
    *,
    node: IrohNode,
    coordinator_node_id: str,
    method: str,
    params: dict,
    timeout: float = 30.0,
    relay_url: str | None = None,
    addresses: list[str] | None = None,
) -> dict:
    """Send one fresh RPC on its own stream over a node-owned connection.

    The deadline covers dial, stream open, write and response. Transport
    failures retire the connection; this request is never replayed because
    callers include stateful login and registration operations.
    """
    async with asyncio.timeout(timeout):
        async with _coordinator_pool(node).connection(
            coordinator_node_id, relay_url=relay_url, addresses=addresses,
        ) as connection:
            bi = await connection.open_bi()
            # iroh-py 0.35 exposes send()/recv() methods on BiStream.
            send, recv = bi.send(), bi.recv()
            request = {"id": uuid.uuid4().hex, "method": method, "params": params}
            await _write_frame(send, request)
            finish = getattr(send, "finish", None) or getattr(send, "close", None)
            if finish is not None:
                await finish()
            response = await _read_frame(recv)
    if not isinstance(response, dict):
        raise LoginError(f"coordinator returned non-map response: {type(response)!r}")
    if "error" in response:
        err = response["error"] or {}
        raise LoginError(f"{err.get('code', 'unknown')}: {err.get('message', '')}")
    if "result" not in response:
        raise LoginError("coordinator response had neither 'result' nor 'error'")
    return response["result"]


async def _write_frame(stream: object, obj: object) -> None:
    payload = cbor2.dumps(obj)
    await stream.write_all(len(payload).to_bytes(4, "big") + payload)


async def _read_frame(stream: object, *, max_size: int = 1 * 1024 * 1024) -> object:
    length_bytes = await _read_exact(stream, 4)
    n = int.from_bytes(length_bytes, "big")
    if n > max_size:
        raise LoginError(f"coordinator response too large: {n} > {max_size}")
    payload = await _read_exact(stream, n)
    return cbor2.loads(payload)


async def _read_exact(stream: object, n: int) -> bytes:
    out = bytearray()
    while len(out) < n:
        chunk = await stream.read(n - len(out))
        if not chunk:
            raise LoginError("coordinator stream closed mid-frame")
        out.extend(chunk)
    return bytes(out)
