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
    vault = SqlDocumentVault(engine, service.authorizer, resolve_space)
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
