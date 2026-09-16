"""Backends — how the tool layer reaches targets.

``StandaloneBackend`` owns an Iroh node and reads targets from a config
file. The embedded ``PeerNetworksBackend`` (which lives in openagent-server,
because it needs server internals) reads the agent's ``peer_networks`` and
borrows the server's running node. Both satisfy ``base.Backend``.
"""
