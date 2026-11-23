"""Compose the standalone agent's existing vault authority with SQL storage."""
from pathlib import Path

SPACE = "agent-vault"


def uses_documents(config):
    backend = (((config or {}).get("memory") or {}).get("vault") or {}).get("backend", "files")
    if backend not in {"files", "documents"}:
        raise ValueError("Unknown memory.vault.backend")
    return backend == "documents"


async def create_document_vault(service):
    from sqlalchemy.engine import URL
    from sqlalchemy.ext.asyncio import create_async_engine
    from openagent_core.memory.vault.documents import SqlDocumentVault

    async def resolve_space(context):
        if context.agent_id != service.agent.name:
            raise PermissionError("Vault belongs to a different agent")
        return SPACE

    database = Path(service.agent.memory_db.db_path).resolve()
    engine = create_async_engine(URL.create("sqlite+aiosqlite", database=str(database)),
                                 connect_args={"timeout": 30})
    from openagent_core.memory.vault.document_dream import DocumentDreamQueue
    queue = DocumentDreamQueue(engine)
    vault = SqlDocumentVault(engine, service.authorizer, resolve_space, dream_queue=queue)
    try:
        await vault.initialize()
        expected = (((service.agent.config.get("memory") or {}).get("vault") or {}).get("expected_import"))
        if expected is not None:
            from openagent_storage_sqlite.vault_import import require_import_receipt
            required = {"tenant","source_manifest_sha256","corpus_sha256"}
            if not isinstance(expected,dict) or set(expected) != required:
                raise ValueError("Invalid expected document import receipt")
            await require_import_receipt(engine,agent=service.agent.name,space=SPACE,**expected)
    except BaseException:
        await engine.dispose()
        raise
    return vault

async def run_scheduled_dream(service, occurrence):
    from dataclasses import replace
    from openagent_core.memory.vault.document_dream import DocumentDreamWorker
    from openagent_core.runtime import current_execution_context, current_runtime
    parent = current_execution_context()
    if (current_runtime() is not service.runtime or parent is None or not parent.deferred
            or "capability:vault" not in parent.scopes):
        raise PermissionError("The scheduled task requires an active vault delegation")
    vault = service.document_vault

    async def authority(claim):
        if (claim.tenant, claim.agent, claim.space) != (parent.tenant_id, parent.agent_id, SPACE):
            raise PermissionError("The scheduled dream belongs to another vault")
        return replace(parent, scopes=("capability:vault", claim.context_scope),
                       session_id=claim.session_id, parent_run_id=None)

    worker = DocumentDreamWorker(vault.dream_queue, authority, vault.resolve_space)
    record = await worker.run_occurrence(service.runtime, vault, parent, occurrence)
    if record.status != "success":
        raise RuntimeError("The document dream ended with " + record.status)
    return record.output


async def create_dream_evidence(service, vault):
    """Pin the source list to one occurrence of the owner's actual scheduled grant."""
    import json
    import sqlalchemy as sa
    from openagent_core.contracts import ResourceRef, SessionRef
    from openagent_core.core.builtin_tasks import DREAM_MODE_TASK_NAME
    from openagent_core.dream_evidence import DocumentDreamEvidence

    bindings = sa.Table("standalone_document_dream_sources", sa.MetaData(),
        sa.Column("agent",sa.Text,primary_key=True), sa.Column("tenant",sa.Text,primary_key=True),
        sa.Column("grant_id",sa.Text,primary_key=True), sa.Column("session",sa.Text,primary_key=True),
        sa.Column("refs",sa.JSON,nullable=False))
    async with vault.engine.begin() as con:
        await con.run_sync(bindings.metadata.create_all)

    async def select(context, scope):
        if (context.audience != (context.initiator,) or not context.deferred
                or scope["space"] != SPACE or scope["tenant"] != context.tenant_id
                or scope["agent"] != service.agent.name or not await service.automations.validate(context)):
            return None
        grant = await service.automations._grant(context.delegation_id)
        if (not grant or grant["kind"] != "task"
                or not {"capability:sessions","capability:vault"}.issubset(json.loads(grant["scopes_json"]))):
            return None
        task = await service.automations.definition("task",grant["definition_id"])
        if task.get("name") != DREAM_MODE_TASK_NAME:
            return None
        key = dict(agent=context.agent_id,tenant=context.tenant_id,grant_id=context.delegation_id,session=context.session_id)
        read = sa.select(bindings.c.refs).filter_by(**key)
        async with vault.engine.connect() as con:
            saved = await con.scalar(read)
        if saved is None:
            page = await service.store.personal_session_page(context, query=None, limit=32, cursor=None, include_archived=False)
            selected = []
            for summary in page["sessions"]:
                ref = SessionRef.parse(summary["session_ref"])
                if (ref.tenant_id != context.tenant_id or ref.agent_id != context.agent_id
                        or ref.authority != context.authority.authority
                        or ref.session_id.startswith(("dream-session-", "automation:"))):
                    continue
                resource = ResourceRef("session",ref.tenant_id,ref.session_id)
                try:
                    for action in ("session.read","run.replay"):
                        await service.runtime.authorize(context,action,resource,audience=context.audience)
                except (PermissionError,LookupError):
                    continue
                selected.append(ref.token)
                if len(selected) == 4:
                    break
            from sqlalchemy.dialects.sqlite import insert
            async with vault.engine.begin() as con:
                await con.execute(insert(bindings).values(**key,refs=selected).on_conflict_do_nothing())
                saved = await con.scalar(read)
        return tuple(SessionRef.parse(token) for token in saved)
    return DocumentDreamEvidence(select)
