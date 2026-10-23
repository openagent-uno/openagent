"""Federation peer policy — ``network.peers`` allowlist, open mode and scope.

These tests drive the REAL auth middleware (``make_auth_middleware``) with the
agent-ALPN contextvar set, not ``peer_policy`` in isolation. That is deliberate
and is the lesson ``test_safety.py`` records in its own header: a test that only
proves ``check_peer_request`` returns a string for a bad path would pass just as
happily in a world where the middleware never calls it — which is exactly how
``safety.approvals`` shipped inert for several releases with the config file
advertising it as protection.

So every test here asserts on what the middleware DID: whether the downstream
handler ran. The policy itself is always built by ``load_peer_policy`` from an
environment mapping — the same call ``AgentServer.start`` makes on the agent's
``product_environment`` — so the startup refusals are tested where they live.

The probe route throughout is ``POST /api/mcps``. That choice is the finding:
it is not a route anyone would call "federation", it takes arbitrary argv, and
the MCP pool spawns it — so if an unenrolled peer reaches it, the ALPN is a
remote-code-execution primitive, not a chat door.
"""
from __future__ import annotations

import os
from contextlib import contextmanager

from ._framework import TestContext, test

# The route that makes the hole a hole: arbitrary argv → pool spawn.
RCE_PATH = "/api/mcps"
# What federation actually uses (src/network/peers.py:569).
CHAT_PATH = "/api/chat"
TRIGGER_PATH = "/api/events/evt_123/trigger"

PEER_A = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888"
PEER_B = "9999ffff8888eeee7777dddd6666cccc5555bbbb4444aaaa3333999922221111"

OPEN = "OPENAGENT_NETWORK_PEER_OPEN"
ALLOWLIST_ENABLED = "OPENAGENT_NETWORK_PEER_ALLOWLIST_ENABLED"
ALLOWLIST = "OPENAGENT_NETWORK_PEER_ALLOWLIST"
SCOPE_ENABLED = "OPENAGENT_NETWORK_PEER_SCOPE_ENABLED"
SCOPE_EXTRA_PATHS = "OPENAGENT_NETWORK_PEER_SCOPE_EXTRA_PATHS"
PEER_KEYS = (OPEN, ALLOWLIST_ENABLED, ALLOWLIST, SCOPE_ENABLED, SCOPE_EXTRA_PATHS)


def _policy(**env: str):
    """Build the startup policy exactly as the server does, from *env*."""
    from openagent_identity.auth.peer_policy import load_peer_policy

    return load_peer_policy(env)


def _refusal(**env: str) -> str:
    """Return the startup refusal for *env*, failing if the policy loads."""
    from openagent_identity.auth.peer_policy import PeerPolicyError

    try:
        policy = _policy(**env)
    except PeerPolicyError as e:
        return str(e)
    raise AssertionError(f"{env} loaded {policy} instead of refusing to start")


@contextmanager
def _clear_peer_env():
    """Clear OPENAGENT_NETWORK_PEER_* from os.environ and always restore them.

    ``_build_agent`` seeds the product environment from ``os.environ``, so a
    var left over from the developer's shell or an earlier test module would
    otherwise leak into the config-wiring assertions.
    """
    prev = {k: os.environ.get(k) for k in PEER_KEYS}
    try:
        for k in PEER_KEYS:
            os.environ.pop(k, None)
        yield
    finally:
        for k, v in prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _state(policy):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from openagent_identity.auth.middleware import NetworkAuthState

    return NetworkAuthState(
        coordinator_pubkey=Ed25519PrivateKey.generate().public_key(),
        network_id="net-test",
        peer_policy=policy,
    )


async def _dial_as_agent(method: str, path: str, *, policy, node_id: str = PEER_A):
    """Drive the real middleware as if a peer dialled the agent ALPN.

    Returns ``(status, handler_ran)``. Sets the same two contextvars
    ``AgentSite._handle_one_stream`` sets before it constructs the aiohttp
    RequestHandler, which is the whole mechanism by which the middleware
    decides a stream is an agent peer.
    """
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request

    from openagent_identity.auth.middleware import make_auth_middleware
    from openagent_identity.transport.aiohttp_iroh_site import (
        _current_peer_node_id,
        _is_authenticated_agent,
    )

    middleware = make_auth_middleware(_state(policy))

    ran = {"called": False}

    async def handler(request):
        ran["called"] = True
        return web.Response(status=200, text="handler-reached")

    req = make_mocked_request(method, path)
    agent_tok = _is_authenticated_agent.set(True)
    node_tok = _current_peer_node_id.set(node_id)
    try:
        resp = await middleware(req, handler)
    finally:
        _is_authenticated_agent.reset(agent_tok)
        _current_peer_node_id.reset(node_tok)
    return resp.status, ran["called"]


ADMIN_ROUTES = (
    ("POST", RCE_PATH),
    ("POST", "/api/marketplace/install"),
    ("GET", "/api/config"),
    ("PUT", "/api/vault/notes/secrets.md"),
    ("POST", "/api/network/invitations"),
    ("POST", "/api/update"),
)
FEDERATION_ROUTES = (
    ("POST", CHAT_PATH),
    ("POST", TRIGGER_PATH),
    ("GET", "/api/health"),
    ("GET", "/api/agent-info"),
)


# ── CLOSED BY DEFAULT — the load-bearing test ───────────────────────


@test("peer_policy", "no network.peers: every peer is refused, POST /api/mcps included")
async def t_closed_by_default(ctx: TestContext) -> None:
    """The hole this module exists for: with no config, a stranger who can
    dial the node used to reach POST /api/mcps — arbitrary argv, spawned by the
    pool. With no ``network.peers`` the ALPN is now closed, and the same is
    true when a host never attaches a policy at all (``peer_policy=None``).
    """
    policy = _policy()
    assert policy.mode == "closed", policy
    for p in (policy, None):
        for method, path in ADMIN_ROUTES + FEDERATION_ROUTES:
            if path == "/api/health":
                continue
            status, ran = await _dial_as_agent(method, path, policy=p, node_id=PEER_B)
            assert status == 403, f"{method} {path}: expected 403, got {status} (policy {p})"
            assert not ran, f"{method} {path}: handler RAN with federation closed"
        # The liveness probe is the one route that skips auth entirely (k8s
        # httpGet carries no identity); it exposes no agent state.
        status, ran = await _dial_as_agent("GET", "/api/health", policy=p, node_id=PEER_B)
        assert ran and status == 200, "the liveness exemption changed"


# ── STARTUP REFUSALS — ambiguity is not guessed in either direction ──


@test("peer_policy", "a network.peers stanza without an allowlist refuses to start")
async def t_stanza_without_allowlist_refuses(ctx: TestContext) -> None:
    """``scope`` alone used to mean "any peer, scoped routes". Reading it as
    either open or closed would silently change a live mesh, so neither is
    chosen: the gateway refuses to start and names both ways out."""
    for env in (
        {SCOPE_ENABLED: "1"},
        {SCOPE_EXTRA_PATHS: "GET ^/api/x$"},
        {OPEN: "false"},
    ):
        message = _refusal(**env)
        assert "node_ids:" in message and "open: true" in message, (
            f"{env}: refusal does not say which lines to add: {message}"
        )


@test("peer_policy", "allowlist.enabled: false no longer means 'accept everyone'")
async def t_legacy_disabled_allowlist_refuses(ctx: TestContext) -> None:
    """The shipped reference config said ``enabled: false`` to mean open. That
    operator made a choice, but under the new default it would read as
    closed — so the old spelling refuses to start until it is restated."""
    message = _refusal(**{ALLOWLIST_ENABLED: "0", ALLOWLIST: ""})
    assert "allowlist.enabled is false" in message and "open: true" in message, message

    # Restated explicitly, the old behaviour is still available.
    policy = _policy(**{ALLOWLIST_ENABLED: "0", OPEN: "1"})
    assert policy.mode == "open", policy


@test("peer_policy", "open together with listed peers refuses to start")
async def t_open_and_allowlist_conflict(ctx: TestContext) -> None:
    for env in (
        {OPEN: "1", ALLOWLIST: PEER_A},
        {OPEN: "true", ALLOWLIST_ENABLED: "1"},
    ):
        message = _refusal(**env)
        assert "open" in message and "allowlist" in message, message
    # An empty list beside open is not a conflict: it admits nobody extra.
    assert _policy(**{OPEN: "1", ALLOWLIST: ""}).mode == "open"


@test("peer_policy", "a toggle that is not a boolean refuses to start")
async def t_garbage_flag_refuses(ctx: TestContext) -> None:
    """A typo used to read as OFF so it could never arm a gate. With the
    policy decided at startup it no longer has to be guessed at all."""
    for name in (OPEN, ALLOWLIST_ENABLED, SCOPE_ENABLED):
        for junk in ("maybe", "2", "enabled", "y"):
            message = _refusal(**{name: junk, ALLOWLIST: PEER_A})
            assert name in message and repr(junk) in message, message

    for spelled in ("1", "true", "YES", " on "):
        assert _policy(**{SCOPE_ENABLED: spelled, ALLOWLIST: PEER_A}).scope
    for spelled in ("0", "false", "No", "off", "", "  "):
        assert not _policy(**{SCOPE_ENABLED: spelled, ALLOWLIST: PEER_A}).scope


# ── ALLOWLIST ───────────────────────────────────────────────────────


@test("peer_policy", "allowlist: an unlisted node is refused, a listed one is not")
async def t_allowlist_enforces(ctx: TestContext) -> None:
    policy = _policy(**{ALLOWLIST: PEER_A})
    status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_B)
    assert status == 403 and not ran, "unlisted peer got through the allowlist"

    status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_A)
    assert ran and status == 200, "listed peer was refused"


@test("peer_policy", "allowlist matching is case-insensitive, like the coordinator's")
async def t_allowlist_case_insensitive(ctx: TestContext) -> None:
    """``coordinator/service.py`` compares node ids with ``.lower()`` when it
    enrols an agent. Being stricter here would reject a peer the coordinator
    had just enrolled — a lockout with a very confusing log line.

    Both directions are exercised on purpose. Normalisation happens at TWO
    sites (``_parse_allowlist`` lowercases the config, ``check_peer_request``
    lowercases the dialling node_id) and a single-direction test only pins one
    of them.
    """
    # config UPPER, dial lower → pins the _parse_allowlist side.
    policy = _policy(**{ALLOWLIST: f"  {PEER_A.upper()} , "})
    status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_A.lower())
    assert ran and status == 200, "config-upper/dial-lower locked out a listed peer"

    # config lower, dial UPPER → pins the check_peer_request side.
    policy = _policy(**{ALLOWLIST: PEER_A.lower()})
    status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_A.upper())
    assert ran and status == 200, "config-lower/dial-upper locked out a listed peer"


@test("peer_policy", "an explicitly empty allowlist starts and refuses every peer")
async def t_allowlist_empty_denies(ctx: TestContext) -> None:
    """``node_ids: []`` (and ``enabled: true`` with no list) is the explicit
    "nobody" an agent that does not federate writes down. It must start, and
    must not be read as "unset, so allow"."""
    for env in ({ALLOWLIST: ""}, {ALLOWLIST_ENABLED: "1"}, {ALLOWLIST_ENABLED: "1", ALLOWLIST: " , "}):
        policy = _policy(**env)
        assert policy.mode == "allowlist" and not policy.allowlist, (env, policy)
        status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_A)
        assert status == 403 and not ran, f"{env}: an empty allowlist admitted a peer"


# ── OPEN — the old default, now a deliberate choice ─────────────────


@test("peer_policy", "open: true admits any node, as the old default did")
async def t_open_admits_anyone(ctx: TestContext) -> None:
    policy = _policy(**{OPEN: "1"})
    for node in (PEER_A, PEER_B):
        status, ran = await _dial_as_agent("POST", RCE_PATH, policy=policy, node_id=node)
        assert ran and status == 200, f"open mode refused {node[:8]} (status {status})"


# ── SCOPE — the blast-radius fix ────────────────────────────────────


@test("peer_policy", "scope on: peer is refused POST /api/mcps but keeps /api/chat")
async def t_scope_blocks_admin_keeps_federation(ctx: TestContext) -> None:
    """The whole point: shrink what a peer reaches without breaking the mesh.

    /api/chat is the ONLY request handle_peer_chat sends over the AGENT ALPN
    (src/network/peers.py:569), and /api/events/{id}/trigger is federation per
    vision §8.5. If either of those 403s here, enabling scope would break real
    federation and no operator would keep it on. Checked for both ways of
    admitting the peer.
    """
    for policy in (
        _policy(**{OPEN: "1", SCOPE_ENABLED: "1"}),
        _policy(**{ALLOWLIST: PEER_A, SCOPE_ENABLED: "1"}),
    ):
        for method, path in ADMIN_ROUTES:
            status, ran = await _dial_as_agent(method, path, policy=policy)
            assert status == 403, f"{policy.mode}: {method} {path}: expected 403, got {status}"
            assert not ran, f"{policy.mode}: {method} {path}: handler RAN despite the 403"
        for method, path in FEDERATION_ROUTES:
            status, ran = await _dial_as_agent(method, path, policy=policy)
            assert ran, f"{policy.mode}: {method} {path}: federation route refused ({status})"
            assert status == 200


@test("peer_policy", "scope matches on method too — GET /api/chat is not POST /api/chat")
async def t_scope_is_method_aware(ctx: TestContext) -> None:
    """A path-only scope would let a peer GET routes that merely share a prefix."""
    policy = _policy(**{ALLOWLIST: PEER_A, SCOPE_ENABLED: "1"})
    status, ran = await _dial_as_agent("GET", CHAT_PATH, policy=policy)
    assert status == 403 and not ran, "GET /api/chat should not ride POST's entry"
    # And a route that merely starts with an allowed prefix stays out.
    status, ran = await _dial_as_agent("POST", "/api/chatterbox/evil", policy=policy)
    assert status == 403 and not ran, "prefix-adjacent path leaked through scope"


@test("peer_policy", "scope extra_paths opens a door without a release")
async def t_scope_extra_paths(ctx: TestContext) -> None:
    """Without this, a federation feature the built-in list doesn't know about
    forces the operator to choose "scope off" — and they would."""
    policy = _policy(**{
        ALLOWLIST: PEER_A,
        SCOPE_ENABLED: "1",
        SCOPE_EXTRA_PATHS: "GET ^/api/vault/notes/.+$",
    })
    status, ran = await _dial_as_agent("GET", "/api/vault/notes/shared.md", policy=policy)
    assert ran and status == 200, "extra_paths entry did not open the route"
    # Still scoped: the write verb on the same path is not implied.
    status, ran = await _dial_as_agent("PUT", "/api/vault/notes/shared.md", policy=policy)
    assert status == 403 and not ran, "extra_paths GET leaked PUT"


@test("peer_policy", "a malformed extra_paths fragment is dropped, not fatal")
async def t_bad_extra_path_is_survivable(ctx: TestContext) -> None:
    """A typo must not stop the gateway. It fails CLOSED (the door stays shut)
    — the safe direction here — and peer_policy emits ``peer.bad_scope_path``
    to say so out loud."""
    policy = _policy(**{
        ALLOWLIST: PEER_A,
        SCOPE_ENABLED: "1",
        SCOPE_EXTRA_PATHS: "GET ^/api/[unclosed,NOMETHOD,GET ^/api/ok$",
    })
    assert len(policy.extra_paths) == 1, policy.extra_paths
    # The good fragment in the same list still applies.
    status, ran = await _dial_as_agent("GET", "/api/ok", policy=policy)
    assert ran and status == 200, "a bad sibling fragment killed a good one"
    # Federation is unaffected by the typo.
    status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy)
    assert ran and status == 200


@test("peer_policy", "who and what stay independent questions")
async def t_toggles_independent(ctx: TestContext) -> None:
    """Scope must not imply an allowlist, and an allowlist must not imply a
    scope — an operator turning on one must not silently get the other."""
    # Open + scope: an unknown peer on an allowed route is admitted.
    policy = _policy(**{OPEN: "1", SCOPE_ENABLED: "1"})
    status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_B)
    assert ran and status == 200, "scope behaved like an allowlist"

    # Allowlist only: a listed peer on an admin route is admitted.
    policy = _policy(**{ALLOWLIST: PEER_A})
    status, ran = await _dial_as_agent("POST", RCE_PATH, policy=policy, node_id=PEER_A)
    assert ran and status == 200, "allowlist-only config behaved like a scope"


# ── The gate must not touch the other transports ────────────────────


@test("peer_policy", "the peer policy does not affect the device-cert path")
async def t_cert_path_untouched(ctx: TestContext) -> None:
    """The gate lives inside the ``current_is_authenticated_agent()`` branch.

    A non-agent stream (a human's device cert, or no cert at all) must reach
    exactly the same outcome whatever the federation policy — otherwise a
    *federation* control would start rejecting the owner's own laptop.
    """
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request

    from openagent_identity.auth.middleware import make_auth_middleware

    async def _dial_without_agent_alpn(policy):
        middleware = make_auth_middleware(_state(policy))

        async def handler(request):
            return web.Response(status=200)

        return await middleware(make_mocked_request("POST", RCE_PATH), handler)

    # No cert wire + not an agent stream ⇒ 401 "missing device cert" under
    # every policy. Not 403.
    statuses = {
        name: (await _dial_without_agent_alpn(policy)).status
        for name, policy in (
            ("unattached", None),
            ("closed", _policy()),
            ("open+scope", _policy(**{OPEN: "1", SCOPE_ENABLED: "1"})),
            ("allowlist", _policy(**{ALLOWLIST: PEER_A})),
        )
    }
    assert set(statuses.values()) == {401}, f"the peer policy changed the device-cert path: {statuses}"


# ── The config file must not lie ────────────────────────────────────


@test("peer_policy", "no write-only OPENAGENT_NETWORK_PEER_* env var exists in src/")
async def t_no_write_only_peer_env(ctx: TestContext) -> None:
    """Guards the defect class that motivated the whole safety pass: five
    ``OPENAGENT_SAFETY_*`` vars were set by server.py and read by nothing for
    months while the example config advertised them as protection.

    ``server.py`` exports into the agent's ``environment`` mapping (the
    product environment), not ``os.environ``, and the readers live in the
    identity package and in Core — so writes are matched in both spellings
    and readers are collected from every tree that can hold one. The read
    regex deliberately does NOT count the write itself (negative lookahead on
    ``=``), and comments are blanked: a docstring naming a var is not a reader.
    """
    import re
    import tokenize
    from pathlib import Path

    import openagent_core

    def _code_only(path: Path) -> str:
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        try:
            with open(path, "rb") as f:
                toks = list(tokenize.tokenize(f.readline))
        except (tokenize.TokenError, SyntaxError, IndentationError):
            return text
        for tok in toks:
            if tok.type == tokenize.COMMENT:
                row, col = tok.start
                lines[row - 1] = lines[row - 1][:col]
        return "\n".join(lines)

    prefix = "OPENAGENT_(?:NETWORK_PEER|MCP_INSTALL)[A-Z_]*"
    server_src = Path(__file__).resolve().parents[2] / "src"
    reader_roots = (
        server_src,
        Path(__file__).resolve().parents[4] / "packages" / "identity" / "src",
        Path(openagent_core.__file__).resolve().parent,
    )
    written: dict[str, str] = {}
    read: set[str] = set()

    w_re = re.compile(rf"(?:os\.environ|environment)\[\s*[\"']({prefix})[\"']\s*\]\s*=[^=]")
    r_re = re.compile(
        rf"(?:\.get\(|os\.getenv\()\s*[\"']({prefix})[\"']"
        rf"|(?:os\.environ|env)\[\s*[\"']({prefix})[\"']\s*\](?!\s*=[^=])"
        rf"|^\s*[A-Za-z_]\w*\s*=\s*[\"']({prefix})[\"']\s*$",
        re.MULTILINE,
    )
    for py in server_src.rglob("*.py"):
        for m in w_re.finditer(_code_only(py)):
            written.setdefault(m.group(1), str(py))
    for root in reader_roots:
        for py in root.rglob("*.py"):
            for m in r_re.finditer(_code_only(py)):
                read.add(next(g for g in m.groups() if g))

    assert written, "found no writers for these vars — the scanner is broken"
    assert {OPEN, ALLOWLIST_ENABLED, ALLOWLIST, SCOPE_ENABLED, SCOPE_EXTRA_PATHS} <= set(written), (
        f"server.py no longer exports every network.peers key: {sorted(written)}"
    )
    orphans = {n: loc for n, loc in written.items() if n not in read}
    assert not orphans, (
        "written but never read — wire a reader or delete the export: "
        f"{orphans}"
    )


@test("peer_policy", "network.peers yaml reaches the gate (config → policy → 403)")
async def t_config_is_wired(ctx: TestContext) -> None:
    """Closes the inverse of the write-only-env defect.

    The other tests build policies by hand, so they would ALL still pass if
    ``_build_agent`` never parsed ``network.peers`` — the yaml would be
    decoration. It was exactly that on 1.1 before this test: ``server.py``
    exported into the agent's product environment while the gate read
    ``os.environ``, so a configured allowlist admitted strangers. This drives
    the real parser, then the same ``load_peer_policy`` call the server makes,
    then the real middleware: yaml in, 403 out.
    """
    from openagent_identity.auth.peer_policy import PeerPolicyError, load_peer_policy
    from openagent_server.server import _build_agent

    model = {"provider": "anthropic", "model": "claude-opus-4-8"}
    with _clear_peer_env():
        agent = _build_agent({
            "name": "TestAgent",
            "model": model,
            "network": {
                "peers": {
                    "allowlist": {"enabled": True, "node_ids": [PEER_A]},
                    "scope": {"enabled": True, "extra_paths": ["GET ^/api/x$"]},
                },
            },
        })
        env = agent.product_environment
        assert env.get(ALLOWLIST_ENABLED) == "1"
        assert env.get(ALLOWLIST) == PEER_A
        assert env.get(SCOPE_ENABLED) == "1"
        assert env.get(SCOPE_EXTRA_PATHS) == "GET ^/api/x$"
        assert not any(k in os.environ for k in PEER_KEYS), (
            "the peer policy leaked into the process environment"
        )

        policy = load_peer_policy(env)
        status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_B)
        assert status == 403 and not ran, "yaml parsed but the gate never fired"
        status, ran = await _dial_as_agent("POST", CHAT_PATH, policy=policy, node_id=PEER_A)
        assert ran and status == 200, "the configured peer was refused"

        # An explicitly empty list is exported, not dropped as if unset.
        agent = _build_agent({
            "name": "TestAgent",
            "model": model,
            "network": {"peers": {"allowlist": {"node_ids": []}}},
        })
        assert agent.product_environment.get(ALLOWLIST) == ""
        assert load_peer_policy(agent.product_environment).mode == "allowlist"

        # ``open`` reaches the policy too — and only a real boolean opens it:
        # a quoted "no" must not be read as truthy.
        agent = _build_agent({
            "name": "TestAgent",
            "model": model,
            "network": {"peers": {"open": True}},
        })
        assert load_peer_policy(agent.product_environment).mode == "open"
        agent = _build_agent({
            "name": "TestAgent",
            "model": model,
            "network": {"peers": {"open": "no", "allowlist": {"node_ids": [PEER_A]}}},
        })
        assert load_peer_policy(agent.product_environment).mode == "allowlist"
        agent = _build_agent({
            "name": "TestAgent",
            "model": model,
            "network": {"peers": {"open": "please"}},
        })
        try:
            load_peer_policy(agent.product_environment)
        except PeerPolicyError as e:
            assert "OPENAGENT_NETWORK_PEER_OPEN" in str(e), e
        else:
            raise AssertionError("a non-boolean network.peers.open did not refuse to start")

        # A node_ids value that is not a list is a config error, not ignored.
        try:
            _build_agent({
                "name": "TestAgent",
                "model": model,
                "network": {"peers": {"allowlist": {"node_ids": 42}}},
            })
        except ValueError as e:
            assert "node_ids" in str(e), e
        else:
            raise AssertionError("a non-list node_ids was silently ignored")

        # An absent stanza exports nothing, and the policy is closed.
        agent = _build_agent({"name": "TestAgent", "model": model})
        leaked = {k: agent.product_environment[k] for k in PEER_KEYS if k in agent.product_environment}
        assert not leaked, f"absent network.peers stanza still exported: {leaked}"
        assert load_peer_policy(agent.product_environment).mode == "closed"


@test("peer_policy", "the shipped reference config starts closed and names no peers")
async def t_example_yaml_peers_closed(ctx: TestContext) -> None:
    """Anyone copying the reference config must get an agent that starts —
    not one that refuses on the legacy ``enabled: false`` — and that admits
    nobody until they list a peer or deliberately set ``open``."""
    from pathlib import Path

    import yaml

    from openagent_server.server import _build_agent

    p = Path(__file__).resolve().parents[2] / "examples" / "openagent.full.yaml"
    cfg = yaml.safe_load(p.read_text(encoding="utf-8"))
    peers = ((cfg.get("network") or {}).get("peers") or {})

    assert peers, "network.peers vanished from the reference config"
    assert peers.get("open", False) is False, "reference opened the agent protocol"
    assert peers["allowlist"]["node_ids"] == [], "reference ships node ids — it must be empty"
    assert peers["scope"]["enabled"] is False, "reference armed the scope"

    from openagent_identity.auth.peer_policy import load_peer_policy

    with _clear_peer_env():
        agent = _build_agent({
            "name": "TestAgent",
            "model": {"provider": "anthropic", "model": "claude-opus-4-8"},
            "network": {"peers": peers},
        })
        policy = load_peer_policy(agent.product_environment)
    assert policy.mode == "allowlist" and not policy.allowlist, policy
