"""Standalone agent-directory bootstrap and shipped default configuration."""
from pathlib import Path
import textwrap

_DEFAULT_YAML = textwrap.dedent("""\
    # OpenAgent agent configuration
    # See https://github.com/openagent-uno/openagent-server for full reference.
    #
    # Providers, models, MCPs, and scheduled tasks are managed exclusively
    # through the SQLite database (configure them via the desktop app or
    # the /api/* REST endpoints). This file only holds server-level knobs.

    name: agent

    network:
      # Path to this agent's Iroh secret key (relative to the agent dir).
      # Generated automatically on first run. Keep at 0600 — leaking it
      # impersonates this agent on the entire network.
      identity_path: ./identity.key

      coordinator:
        # Path to the coordinator's signing key. Only used when this
        # agent has been promoted to network coordinator via
        # ``openagent network init``.
        key_path: ./coordinator.key

      # Optional: override Iroh's public DERP relay. Empty = use Iroh's
      # public network. Self-host one for full data locality.
      derp_url: ""

    channels:
      # Bridges (telegram, discord, whatsapp) connect as network clients
      # rather than via host:port. See `openagent network invite --role user`.
""")


def ensure_agent_dir(path: Path) -> Path:
    """Create an agent directory with default structure if it doesn't exist.

    Creates:
      <path>/openagent.yaml   (minimal config)
      <path>/memories/         (memory vault)
      <path>/logs/             (log files)

    Returns the resolved absolute path.
    """
    path = path.resolve()
    path.mkdir(parents=True, exist_ok=True)

    config_file = path / "openagent.yaml"
    if not config_file.exists():
        config_file.write_text(_DEFAULT_YAML)

    (path / "memories").mkdir(exist_ok=True)
    (path / "logs").mkdir(exist_ok=True)
    (path / "skills").mkdir(exist_ok=True)

    return path


