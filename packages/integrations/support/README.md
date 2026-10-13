# openagent-support-integration

An optional host integration boundary built on the public Core `EngineExtensions` contract. OpenAgent ships no customer identities, business routing tables, provider installation IDs, policy paths or support automation selected from a task name. The standalone server has no support callbacks by default.

The embedding host owns authentication, grants, tool registration, business policy and the adapter's IO. It may construct immutable `SupportProfile` objects with explicit event slugs, permitted operations, tool bindings, policy and options. `SupportIdentity(authority_id, tenant_id, profile_id)` must come from an authenticated host grant, independently of the event payload and task name. Missing configuration disables the integration; partial configuration fails at startup. An unknown identity or conflicting `supportProfile`, `supportTenant` or `supportAuthority` assertion fails before the adapter is called. Core capability authorization still applies to each tool call.

```python
from openagent_support.configuration import (
    SupportConfiguration, SupportIdentity, SupportProfile,
)
from openagent_support.extensions import support_extensions
from openagent_server.server import AgentServer

identity = SupportIdentity("host-alpha", "tenant-alpha", "profile-alpha")
configuration = SupportConfiguration((SupportProfile(
    identity=identity,
    event_slugs=("customer-support",),
    operations=("event", "quality_scorer", "quality_digest"),
    tool_bindings={"thread_read": "support-api/read"},
    policy={"automatic_refunds": False},
    options={"reply_limit": 300},
),))

async def resolve_identity(*, kind, agent, definition, session_id):
    # Host code must authenticate the agent and resolve the configured event or
    # task's grant. Never construct this identity from its payload or name.
    return await host_grants.support_identity(agent, kind, definition["id"], session_id)

extensions = support_extensions(
    configuration=configuration,
    identity_resolver=resolve_identity,
    adapter=host_support_adapter,
)
server = AgentServer.from_config(server_configuration, engine_extensions=extensions)
```

`SupportAdapter.handle_event` receives keyword arguments `profile`, `identity`, `agent`, `event`, `payload`, `session_id`, `delivery_id`. `handle_scheduled` receives `profile`, `identity`, `operation`, `agent`, `task`, `prompt`, `session_id`, `dry_run`. The scheduled operation is `quality_scorer` or `quality_digest`, explicitly requested by the corresponding `[[quality-scorer]]` or `[[quality-digest]]` marker and permitted by the profile. A prompt containing both markers is rejected. Dry-run is forwarded unchanged; the host adapter must enforce its write policy rather than claiming that the callback alone simulates IO.

The host can supply its own output retainer, content validator and execution-profile selector. There are no implicit model choices or controller environment switches. `support_delivery_receipts.retain_event_output` accepts an explicit `controller_ids` tuple for host receipt formats; the generic default recognizes `support-local-v1` only.

Previous business controllers, scorers, operator scripts, tenant-specific regression corpora and their original baseline were extracted to a private host-owned archive, with original hashes and source provenance preserved. They are excluded from this package and from generic qualification. Their operations are preserved as host plugin source, but need explicit configuration, public capability integration and host regression qualification before deployment. This change does not deploy or silently rewrite any existing host installation.

Verify the generic admission boundary with:

```sh
PYTHONPATH=packages/integrations/support/src python -m unittest discover -s tests -p test_support_configuration.py -v
```

`tests/verify_support.py` instead requires the installed wheel and runs the same admission and receipt regressions against it. It has no tenant-specific baseline exemptions and makes no claim to qualify an external business plugin.
