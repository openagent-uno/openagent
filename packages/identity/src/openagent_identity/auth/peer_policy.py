"""Federation peer policy — the enforcement half of ``network.peers``.

WHY THIS MODULE EXISTS
----------------------
``src/network/transport/agent_iroh_site.py`` accepts the
``openagent/agent/1`` ALPN and hands the stream to the SAME aiohttp
``AppRunner`` the gateway serves to first-party clients. Its own docstring
says so plainly: "Every route registered on the shared aiohttp app is
reachable". The auth middleware then synthesises a ``DeviceCert`` with
``capabilities=["agent"]`` for whoever dialled, and its own comment admitted
the consequence: "the agent-ALPN endpoint trusts any node that can dial it".

The Iroh QUIC handshake proves the peer owns its node_id. It does not prove
the peer is anyone we know. There is no inbound enrolment on this path — no
invite is consumed, no coordinator cert is checked — so "authenticated" here
means "has a keypair", which every host on the internet can arrange.

WHAT THAT ACTUALLY OPENED — MEASURE IT, DON'T ASSUME
----------------------------------------------------
It is tempting to read ``capabilities=["agent"]`` as a scope. It is not one.
Exactly two places in the tree look at that field, and NEITHER is an
authorisation check:

  - ``src/gateway/api/events.py:326`` — picks the delivery's ``source``
    label ("peer" vs "manual"). A provenance string for the audit trail.
  - ``src/gateway/api/chat.py:146``  — namespaces the session id
    (``peer:<node16>:…``) so peer threads don't collide on "default".

There is no ``require_capability`` helper anywhere in ``src/``. So the
capability is a *label*, and an unenrolled dialler reaches every route the
gateway registers, including:

  - ``POST /api/mcps``               — arbitrary argv, spawned by the pool's
                                       hot-reload → remote code execution,
                                       no marketplace round-trip needed.
  - ``POST /api/marketplace/install``— the same, via the registry.
  - ``GET/PUT /api/config``          — read and rewrite config.
  - ``PUT /api/vault/notes/{path}``  — read and rewrite memory.
  - ``POST /api/network/invitations``— mint an invite into the network.
  - ``POST /api/update``/``restart`` — control the process.

So the honest blast radius of the ALPN path is not "a peer can fire an
event". It is "a stranger who can dial this node owns it". ``/api/events/
{id}/trigger`` is one of roughly a hundred doors, and far from the worst.

TWO INDEPENDENT QUESTIONS, TWO TOGGLES
--------------------------------------
Conflating them produces a gate that is either useless or unshippable:

  1. WHO may dial            → ``allowlist``. Needs per-deployment data
                               (which node_ids are my peers?).
  2. WHAT a peer may reach   → ``scope``. Has a knowable correct answer,
                               derived from the code, independent of
                               deployment.

``scope`` is the one that shrinks the blast radius even for an enrolled peer
— vision §11 says federated agents "exchange messages, collaborate on tasks,
and share context with explicit permission", which is ``/api/chat`` and
``/api/events/{id}/trigger``. It never says a colleague may install software
on your host. An allowlist alone still hands every allowlisted peer root.

CLOSED UNLESS THE OPERATOR SAYS OTHERWISE
-----------------------------------------
Both toggles used to default OFF, which made the safe-looking default the
unsafe one: with no ``network.peers`` stanza every dialler owned the node.
The policy is now explicit and fixed at startup (``load_peer_policy``):

  - no ``network.peers`` at all   → federation is closed: every agent-ALPN
                                    stream is refused (``peer.denied``,
                                    reason=not_configured). Nothing that
                                    never federated changes behaviour.
  - ``allowlist.node_ids``        → only the listed node_ids may dial; an
                                    empty list is an explicit "nobody".
  - ``open: true``                → any node may dial (the old default),
                                    as a deliberate, logged choice.

Anything in between refuses to START rather than guess: a stanza with no
allowlist and no ``open`` (the old "scope only" shape), the legacy
``allowlist.enabled: false`` that used to mean "accept everyone", ``open``
together with listed peers, or a toggle value that is not a boolean. These
agents run unattended, so a silent flip in either direction is the outage
nobody notices; a process that will not start, and says which line to add,
is the one somebody fixes before 3am.

BUILDING THE ALLOWLIST
----------------------
The ``agent.contact`` audit line in ``middleware.py`` has been recording
every dialling node_id since the ALPN shipped — it was added as "Phase-0
security: record every first-contact agent node_id so the allowlist can be
built / audited". So the operator does not have to guess:

    grep '"event":"agent.contact"' <agent dir>/logs/events.jsonl \\
      | jq -r .node_id | sort -u

is the list of peers that actually dial them; copy it into
``network.peers.allowlist.node_ids``. A peer that has not dialled within the
log's retention will not appear, and is refused with a ``peer.denied`` line
naming its node_id rather than failing silently.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from openagent_core.core.logging import elog

_OPEN_ENV = "OPENAGENT_NETWORK_PEER_OPEN"
_ALLOWLIST_ENABLED_ENV = "OPENAGENT_NETWORK_PEER_ALLOWLIST_ENABLED"
_ALLOWLIST_ENV = "OPENAGENT_NETWORK_PEER_ALLOWLIST"
_SCOPE_ENABLED_ENV = "OPENAGENT_NETWORK_PEER_SCOPE_ENABLED"
_SCOPE_EXTRA_PATHS_ENV = "OPENAGENT_NETWORK_PEER_SCOPE_EXTRA_PATHS"
_PEER_ENVS = (
    _OPEN_ENV,
    _ALLOWLIST_ENABLED_ENV,
    _ALLOWLIST_ENV,
    _SCOPE_ENABLED_ENV,
    _SCOPE_EXTRA_PATHS_ENV,
)

# The routes federation actually uses over ``openagent/agent/1``. Derived
# from the code, not from taste — a wrong entry here is a broken mesh the
# moment someone enables the scope:
#
#   POST /api/chat                  ``src/network/peers.py:569`` — the only
#                                   request handle_peer_chat sends through
#                                   AgentDialer/LoopbackProxy.
#   POST /api/events/{id}/trigger   vision §8.5 ("a member or a federated
#                                   peer can fire an event over the peer-to-
#                                   peer network with their device identity")
#                                   and ``src/memory/db.py:708``, which
#                                   documents the ``peer`` delivery source as
#                                   arriving via "agent ALPN".
#   GET  /api/health                liveness; read-only, no agent state.
#   GET  /api/agent-info            identity/name discovery; read-only.
#
# Anything else a peer asks for is administration, not collaboration. If a
# future federation feature adds a route, add it here — extending the tuple
# is the deliberate act; ``extra_paths`` exists so an operator is never
# forced to choose between "scope off" and "wait for a release".
_FEDERATION_ROUTES: tuple[tuple[str, str], ...] = (
    ("POST", r"^/api/chat/?$"),
    ("POST", r"^/api/events/[^/]+/trigger/?$"),
    ("GET", r"^/api/health/?$"),
    ("GET", r"^/api/agent-info/?$"),
)



_ON = frozenset({"1", "true", "yes", "on"})
_OFF = frozenset({"0", "false", "no", "off"})

_HOW_TO_CONFIGURE = """\
List the peers that may dial this agent (an empty list admits nobody):

  network:
    peers:
      allowlist:
        node_ids: ["<node id>", ...]

or accept any node that can dial it, deliberately:

  network:
    peers:
      open: true

The node ids that already dial this agent are in its event log:
  grep '"event":"agent.contact"' <agent dir>/logs/events.jsonl | jq -r .node_id | sort -u"""


class PeerPolicyError(ValueError):
    """``network.peers`` is ambiguous or malformed; the gateway must not start."""


@dataclass(frozen=True)
class PeerPolicy:
    """Who may use the ``openagent/agent/1`` ALPN, and what they may reach.

    Built once at startup by ``load_peer_policy`` and handed to the auth
    middleware through ``NetworkAuthState.peer_policy``; nothing reads the
    environment per request, so a policy cannot change under a live gateway.
    """

    mode: Literal["closed", "allowlist", "open"]
    allowlist: frozenset[str] = frozenset()
    scope: bool = False
    extra_paths: tuple[tuple[str, re.Pattern[str]], ...] = ()

    def summary(self) -> dict[str, object]:
        """Log-safe description: counts, never node ids."""
        return {
            "mode": self.mode,
            "allowlisted": len(self.allowlist),
            "scope": self.scope,
            "extra_paths": len(self.extra_paths),
        }


CLOSED_PEER_POLICY = PeerPolicy(mode="closed")


def _toggle(env: Mapping[str, str], name: str) -> bool | None:
    """Parse a boolean toggle: ``None`` when unset, an error when not a boolean.

    A typo used to read as OFF so it could never arm a gate on a live mesh.
    With the policy validated at startup a typo no longer has to be guessed
    in either direction: the gateway refuses to start and names the value.
    """
    if name not in env:
        return None
    value = env[name].strip().lower()
    if value == "":
        return None
    if value in _ON:
        return True
    if value in _OFF:
        return False
    raise PeerPolicyError(f"{name}={env[name]!r} is not a boolean (use true or false)")


def _parse_allowlist(raw: str) -> frozenset[str]:
    """Parse the comma-separated node_id allowlist.

    Node ids are compared case-insensitively: iroh renders them as hex and the
    coordinator itself compares with ``.lower()`` (``coordinator/service.py``
    ``peer_node_id.lower() != node_id.lower()``), so being stricter here than
    the enrolment path would reject peers the coordinator just enrolled.
    """
    return frozenset(
        seg.strip().lower() for seg in raw.split(",") if seg.strip()
    )


def _parse_extra_paths(raw: str) -> tuple[tuple[str, re.Pattern[str]], ...]:
    """Parse ``scope.extra_paths`` — ``METHOD /path/re`` fragments.

    An unparseable fragment is dropped with an audit line rather than failing
    startup, and that failure mode is the safe one: a dropped ALLOW fragment
    fails *closed*, narrowing the scope — hence the dedicated audit event.
    """
    out: list[tuple[str, re.Pattern[str]]] = []
    for frag in (seg.strip() for seg in raw.split(",")):
        if not frag:
            continue
        parts = frag.split(None, 1)
        if len(parts) != 2:
            elog(
                "peer.bad_scope_path",
                pattern=frag,
                error="expected '<METHOD> <path-regex>'",
            )
            continue
        method, path_re = parts[0].strip().upper(), parts[1].strip()
        try:
            out.append((method, re.compile(path_re)))
        except re.error as e:
            elog("peer.bad_scope_path", pattern=frag, error=str(e))
    return tuple(out)


def load_peer_policy(env: Mapping[str, str]) -> PeerPolicy:
    """Build the startup peer policy from the product environment.

    *env* is the mapping ``server.py`` exports ``network.peers`` into (the
    agent's ``product_environment``), so operator-exported
    ``OPENAGENT_NETWORK_PEER_*`` variables are honoured the same way.
    Raises ``PeerPolicyError`` for every configuration this module refuses to
    guess about — see the module docstring.
    """
    open_mode = _toggle(env, _OPEN_ENV)
    allowlist_enabled = _toggle(env, _ALLOWLIST_ENABLED_ENV)
    scope = _toggle(env, _SCOPE_ENABLED_ENV)
    listed = _parse_allowlist(env[_ALLOWLIST_ENV]) if _ALLOWLIST_ENV in env else None
    extra_paths = _parse_extra_paths((env.get(_SCOPE_EXTRA_PATHS_ENV) or "").strip())

    if not any(name in env for name in _PEER_ENVS):
        return CLOSED_PEER_POLICY

    if open_mode:
        if allowlist_enabled or listed:
            raise PeerPolicyError(
                "network.peers.open is true but network.peers.allowlist also "
                "admits specific peers. Keep one: remove open to accept only "
                "the listed peers, or remove the allowlist to accept any node."
            )
        return PeerPolicy(mode="open", scope=bool(scope), extra_paths=extra_paths)

    if allowlist_enabled is False:
        raise PeerPolicyError(
            "network.peers.allowlist.enabled is false, which used to accept "
            "every node that can dial this agent. That now has to be said "
            "explicitly, or replaced by a list of peers.\n\n" + _HOW_TO_CONFIGURE
        )
    if listed is None and allowlist_enabled is None:
        raise PeerPolicyError(
            "network.peers is configured without an allowlist, so it is "
            "unclear which nodes may use the agent protocol. Without one, "
            "any node that can dial this agent reaches the gateway API.\n\n"
            + _HOW_TO_CONFIGURE
        )
    return PeerPolicy(
        mode="allowlist",
        allowlist=listed or frozenset(),
        scope=bool(scope),
        extra_paths=extra_paths,
    )


def _scope_permits(policy: PeerPolicy, method: str, path: str) -> bool:
    for m, pat in _FEDERATION_ROUTES:
        if m == method and re.match(pat, path):
            return True
    for m, pat in policy.extra_paths:
        if m == method and pat.match(path):
            return True
    return False


def check_peer_request(
    *, policy: PeerPolicy, node_id: str, method: str, path: str,
) -> str | None:
    """Return a denial reason for an agent-ALPN request, or ``None`` to allow.

    Returns a reason string instead of raising: the caller is aiohttp
    middleware that must turn this into a 403 response, and an exception there
    would surface as a 500 and read like a server bug to the peer.
    """
    if policy.mode != "open" and node_id.strip().lower() not in policy.allowlist:
        closed = policy.mode == "closed"
        elog(
            "peer.denied",
            level="warning",
            reason="not_configured" if closed else "not_in_allowlist",
            node_id=node_id,
            method=method,
            path=path,
        )
        if closed:
            return "agent protocol is closed: network.peers is not configured"
        return "peer not in network.peers.allowlist"

    if policy.scope and not _scope_permits(policy, method, path):
        # Logged at warning with the full path: this is the line an operator
        # greps to discover that a legitimate federation feature needs an
        # ``extra_paths`` entry — the same way ``agent.contact`` is how they
        # build the allowlist. A denial nobody can diagnose gets the whole
        # gate switched back off.
        elog(
            "peer.denied",
            level="warning",
            reason="outside_scope",
            node_id=node_id,
            method=method,
            path=path,
        )
        return f"{method} {path} is outside network.peers.scope"

    return None
