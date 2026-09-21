"""Standalone gateway adapter over the single public runtime run service."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
import uuid
import os

from aiohttp import web

from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.contracts import IdempotencyConflict, RunRequest
from openagent_core.engine import AgentExecutor, AgentModelCatalog
from openagent_core.core.on_behalf_context import current_on_behalf_identity
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.runtime_access import NativeRuntimeAuthorizer


@dataclass(slots=True)
class PreparedRun:
    request: Any
    context: Any
    cancel_on_detach: bool = True


class RuntimeAgentFacade:
    """Retain transport properties while all reasoning uses public admission."""

    def __init__(self, service: NativeRuntimeService, agent: Any):
        object.__setattr__(self, "_service", service)
        object.__setattr__(self, "_agent", agent)

    def __getattr__(self, name: str):
        return getattr(self._agent, name)

    def __setattr__(self, name: str, value: Any):
        setattr(self._agent, name, value)

    def canonical_access_context(self, principal):
        from openagent_identity.runtime_access import AccessContext

        return AccessContext.from_on_behalf_identity(principal)

    async def run_stream(
        self,
        message: str,
        user_id: str = "",
        session_id: str | None = None,
        attachments: list[dict] | None = None,
        on_status: Any = None,
        model_override: Any = None,
        author: dict | None = None,
        run_id: str | None = None,
        steer_run_id: str | None = None,
    ):
        if not session_id:
            raise ValueError("A durable runtime session ID is required")
        prepared = self._service.prepared_runs.get(run_id) if run_id else None
        if prepared is not None:
            identity = current_on_behalf_identity()
            from openagent_core.contracts import PrincipalRef

            if identity is None or prepared.context.initiator != PrincipalRef(
                "openagent",
                identity.tenant_id,
                identity.handle,
                identity.principal_type,
            ):
                raise PermissionError(
                    "Prepared run does not match this authenticated turn"
                )
            if (
                prepared.request.session_id != session_id
                or prepared.request.input != message
                or tuple(prepared.request.attachments) != tuple(attachments or ())
            ):
                raise IdempotencyConflict(
                    "Prepared run input differs from the accepted request"
                )
            async for event in self._service.observe_run(prepared, on_status=on_status):
                yield event
            return
        from openagent_core.runtime import current_runtime, current_execution_context

        active = (
            current_execution_context()
            if current_runtime() is self._service.runtime
            else None
        )
        if active is not None:
            context = active
        else:
            identity = current_on_behalf_identity()
            if identity is None:
                raise PermissionError(
                    "Agent execution requires verified ingress or an explicit delegation"
                )
        model_ref = None
        if model_override is not None:
            model_ref = getattr(model_override, "runtime_id", None)
            if not model_ref:
                raise ValueError("Model overrides require a registered model reference")
        identifier = run_id or str(uuid.uuid4())
        request = RunRequest(
            identifier,
            session_id,
            identifier,
            message,
            attachments=tuple(attachments or ()),
            model_ref=model_ref,
            steer_run_id=steer_run_id,
        )
        if active is not None:
            await self._service.runtime.spawn(
                request, context, deferred=context.deferred
            )
            self._service.prepared_runs.setdefault(
                identifier, PreparedRun(request, context)
            )
        else:
            from openagent_core.core.execution_origin import (
                current_execution_origin,
                current_ingress_identity,
            )

            await self._service.admit_message(
                identity=identity,
                message=message,
                session_id=session_id,
                run_id=identifier,
                attachments=attachments or (),
                model_ref=model_ref,
                steer_run_id=steer_run_id,
                origin=current_execution_origin(),
                ingress=current_ingress_identity(),
            )
        async for event in self._service.observe_run(
            self._service.prepared_runs[identifier], on_status=on_status
        ):
            yield event

    async def run(self, message: str, **kwargs):
        parts = []
        final = None
        async for event in self.run_stream(message, **kwargs):
            if event.get("kind") == "delta":
                parts.append(event.get("text") or "")
            elif event.get("kind") == "done":
                final = event.get("text") or ""
        return final if final is not None else "".join(parts)


class NativeRuntimeService:
    def __init__(self, gateway: Any, agent: Any):
        self.gateway = gateway
        self.agent = agent
        from openagent_server.runtime_directory import NativeRuntimeDirectory

        self.directory = NativeRuntimeDirectory(gateway, agent)
        if not getattr(gateway, "runtime_audience_resolver", None):
            gateway.runtime_audience_resolver = self.directory.audience
        if not getattr(gateway, "runtime_principal_active", None):
            gateway.runtime_principal_active = self.directory.principal_active
        self._interactive_sources: dict[str, str] = {}
        self._interactive_leases: dict[str, tuple] = {}
        self._interactive_origins: dict[str, tuple] = {}
        self.authorizer = NativeRuntimeAuthorizer(
            gateway,
            agent.memory_db.db_path,
            source_authorizer=getattr(gateway, "runtime_source_authorizer", None)
            or self._authorize_source,
        )
        self.capability_context_resolver = (
            getattr(gateway, "runtime_capability_context_resolver", None)
            or self._capability_context
        )
        from openagent_server.catalog_service import NativeCatalogService

        self.catalog_management = NativeCatalogService(agent, self.authorizer)
        self.store = SqliteRuntimeStore(agent.memory_db.db_path)
        self.runtime = None
        self.prepared_runs: dict[str, PreparedRun] = {}
        self.dashboards = None
        self.code_executor = None
        from openagent_server.automation_authority import NativeAutomationAuthority

        self.automations = NativeAutomationAuthority(self)
        self.authorizer.delegations = self.automations
        from openagent_server.automation_management import NativeAutomationManagement

        self.automation_management = NativeAutomationManagement(self)
        from openagent_server.automation_execution import NativeAutomationExecution

        self.automation_execution = NativeAutomationExecution(self)
        from openagent_server.memory_access import NativeMemoryAccess

        self.memory_access = NativeMemoryAccess(self)
        self.authorizer.memory_authorizer = self.memory_access.authorize
        self.facade = RuntimeAgentFacade(self, agent)
        from openagent_core.automation_runtime import AutomationRuntime

        self.automation_runtime = AutomationRuntime(
            self.agent.memory_db, self.facade, self.automation_execution,
        )

    async def admit_message(
        self,
        *,
        identity,
        message,
        session_id,
        run_id,
        attachments=(),
        origin=None,
        ingress=None,
        steer_run_id=None,
        model_ref=None,
    ):
        from dataclasses import replace
        from openagent_core.core.execution_origin import (
            execution_origin_scope,
            ingress_identity_scope,
        )
        from openagent_core.core.on_behalf_context import (
            install_on_behalf_identity,
            reset_on_behalf_identity,
        )
        from openagent_core.contracts import PrincipalRef

        principal = PrincipalRef(
            "openagent", identity.tenant_id, identity.handle, identity.principal_type
        )
        token = install_on_behalf_identity(identity)
        try:
            with execution_origin_scope(origin), ingress_identity_scope(ingress):
                context = await self.authorizer.context_for_identity(
                    identity, session_id
                )
                try:
                    accepted = await self.runtime.accepted_request(run_id, context)
                except LookupError:
                    accepted = None
                if accepted is not None:
                    request = accepted.request
                    if (
                        accepted.initiator != principal
                        or accepted.author != principal
                        or request.session_id != session_id
                        or request.input != message
                        or tuple(request.attachments) != tuple(attachments)
                        or request.model_ref != model_ref
                    ):
                        raise IdempotencyConflict(
                            "Request differs from its durable acceptance"
                        )
                    # Observation uses current authorization. Original capability
                    # leases and steering target never become a new execution.
                    prepared = PreparedRun(request, context, cancel_on_detach=False)
                    self.prepared_runs[run_id] = prepared
                    return prepared
                context = replace(
                    context,
                    capabilities=tuple(await self.capability_context_resolver(context)),
                )
                request = RunRequest(
                    run_id,
                    session_id,
                    run_id,
                    message,
                    attachments=tuple(attachments),
                    model_ref=model_ref,
                    steer_run_id=steer_run_id,
                )
                await self.runtime.submit(request, context)
        finally:
            reset_on_behalf_identity(token)
        prepared = PreparedRun(request, context)
        self.prepared_runs[run_id] = prepared
        return prepared

    async def observe_run(self, prepared, *, on_status=None):
        identifier = prepared.request.run_id
        context = prepared.context
        cursor = 0
        completed_frame = False
        tool_statuses = {}
        try:
            while True:
                for event in await self.runtime.events(identifier, cursor, context):
                    cursor = event.cursor
                    if event.kind == "run.stream":
                        payload = dict(event.payload)
                        completed_frame = (
                            completed_frame or payload.get("kind") == "done"
                        )
                        yield payload
                    elif event.kind == "run.status" and on_status is not None:
                        text = str(event.payload.get("text") or "")
                        import json

                        try:
                            status = json.loads(text)
                        except (ValueError, TypeError):
                            status = None
                        # The public catalog emits the actual invocation with
                        # a durable call ID and a verified destination.
                        if (
                            not isinstance(status, dict)
                            or status.get("tool_name") != "tool_search_call_tool"
                        ):
                            await on_status(text)
                    elif (
                        event.kind in {"tool.invoking", "tool.completed"}
                        and on_status is not None
                    ):
                        import json

                        call_id = event.payload["call_id"]
                        if (
                            event.kind == "tool.invoking"
                            or call_id not in tool_statuses
                        ):
                            binding = event.payload["binding"]
                            tool_statuses[call_id] = {
                                "tool_call_id": call_id,
                                "tool_name": binding["name"],
                                "tool_server": binding["source_id"],
                                "tool_args": event.payload["arguments"],
                                "execution_host": binding.get("execution_host"),
                                "result": None,
                            }
                        if event.kind == "tool.completed":
                            status = tool_statuses.get(call_id)
                            if status is None:
                                continue
                            status["result"] = json.dumps(
                                event.payload.get("result", event.payload.get("error"))
                            )
                            status["tool_call_error"] = (
                                event.payload.get("status") != "success"
                            )
                        await on_status(json.dumps(tool_statuses[call_id]))
                record = await self.runtime.get_run(identifier, context)
                if record.terminal:
                    if record.status != "success":
                        raise RuntimeError(
                            f"Agent run ended with status {record.status}"
                        )
                    if not completed_frame:
                        yield {
                            "kind": "done",
                            "text": record.output or "",
                            "run_id": identifier,
                        }
                    return
                await asyncio.sleep(0.025)
        except asyncio.CancelledError:
            # StreamSession cancels its consumer for an explicit stop/barge-in;
            # websocket detach does not close the server-owned StreamSession.
            if prepared.cancel_on_detach:
                await asyncio.shield(self.runtime.cancel(identifier, context))
            raise

    async def start(self):
        from dataclasses import replace
        from openagent_core.capabilities import CapabilityCatalog
        from openagent_core import ServiceRegistry
        from openagent_core import DelegationService, ModelCatalog
        from openagent_core.code_execution import CodeExecutor
        from openagent_core.memory_access import MemoryAccess

        await self.catalog_management.start()
        await self.automations.start()
        executor = AgentExecutor(self.agent, owns_agent=False)
        environment = dict(getattr(self.agent, "product_environment", os.environ))
        from openagent_server.code_execution import build_code_executor

        self.code_executor = build_code_executor(self.agent.config, environment)
        from openagent_core.mcp.pool import MCPPool
        from openagent_server.bootstrap import standalone_spec_resolver
        from openagent_product_config import build_module_catalog, standalone_profile

        async def mcp_pool_factory(_module_context):
            pool = await MCPPool.from_db(
                self.agent.memory_db,
                db_path=self.agent.memory_db.db_path,
                host_spec_resolver=standalone_spec_resolver(
                    self.agent.config, environment=environment
                ),
            )
            pool.bind_agent_runtime(self.agent)
            return pool

        memory_config = self.agent.config.get("memory") or {}
        vault_path = Path(
            memory_config.get("vault_path")
            or Path(self.agent.memory_db.db_path).resolve().parent / "memories"
        )
        profile = standalone_profile(
            generation=max(1, int(self.agent.config.get("_runtime_profile_generation", 1))),
            db_path=self.agent.memory_db.db_path,
            vault_path=vault_path,
            environment=environment,
            mcp_pool_factory=mcp_pool_factory,
            automation_runtime=self.automation_runtime,
            ptc_enabled=bool((self.agent.config.get("ptc") or {}).get("enabled")),
            local_e2e=self.agent.config.get("_local_e2e") is True,
        )
        model_catalog = AgentModelCatalog(self.agent, self.authorizer)
        registry = ServiceRegistry({
            "module.reference_inspector": self.automation_management,
            ModelCatalog: model_catalog,
            "models": model_catalog,
            DelegationService: self.automations,
            "delegations": self.automations,
            "catalog_management": self.catalog_management,
            "automation_management": self.automation_management,
            "user_sources": self.catalog_management.user_sources,
            MemoryAccess: self.memory_access,
            "memory_access": self.memory_access,
        })
        if self.code_executor is not None:
            registry.bind(CodeExecutor, self.code_executor)
            registry.bind("code_executor", self.code_executor)
        self.runtime = Runtime(
            RuntimeSettings(
                self.agent.name,
                Path(self.agent.memory_db.db_path).resolve().parent,
                environment=tuple(sorted(environment.items())),
                child_concurrency=max(
                    1, int(environment.get("OPENAGENT_CHILD_SESSION_CONCURRENCY", "16"))
                ),
                child_max_depth=max(
                    1, int(environment.get("OPENAGENT_CHILD_SESSION_MAX_DEPTH", "5"))
                ),
                child_chain_concurrency=max(
                    1,
                    int(
                        environment.get(
                            "OPENAGENT_CHILD_SESSION_PER_CHAIN",
                            environment.get("OPENAGENT_CHILD_SESSION_PER_PARENT", "8"),
                        )
                    ),
                ),
            ),
            RuntimeServices(
                self.store,
                executor,
                self.authorizer,
                capabilities=CapabilityCatalog(self.authorizer, allow_dynamic=True),
                registry=registry,
            ),
            modules=(executor,),
            profile=profile,
            module_catalog=build_module_catalog(),
        )
        if hasattr(self.agent, "extensions"):
            from openagent_server.dashboard_capabilities import DashboardCapabilities

            self.dashboards = DashboardCapabilities(self.gateway, self.agent)
            self.agent.extensions = replace(
                self.agent.extensions,
                content_validator=self.dashboards.content_validator,
            )
            from openagent_product_config.prompts import ProductPromptProvider

            self.agent.host_prompt_provider = ProductPromptProvider(
                self._dashboard_prompt_available, include_defaults=False
            )
        from openagent_core.runtime import runtime_scope
        from openagent_core.core.hooks import set_quick_commands, set_hooks

        with runtime_scope(self.runtime):
            set_quick_commands(self.agent.config.get("quick_commands") or {})
            set_hooks(self.agent.config.get("hooks") or {})
        await self.runtime.start()
        mcp_service = self.runtime.service("mcp.service")
        if mcp_service is not None and mcp_service.pool is not None:
            mcp_service.pool.bind_gateway_runtime(self.gateway)

    def _dashboard_prompt_available(self, context):
        from openagent_core.contracts import ResourceRef

        if context is None or self.dashboards is None:
            return False
        return any(
            self.dashboards.authorize_source(
                context,
                "tool.discover",
                ResourceRef("capability", context.tenant_id, lease.source_id),
                audience=context.audience,
            )
            is True
            for lease in context.capabilities
        )

    async def close(self):
        try:
            if self.runtime is not None:
                await self.runtime.close()
        finally:
            if self.code_executor is not None:
                await self.code_executor.close()

    def revoke_connection(self, connection_id):
        if self.dashboards is not None:
            self.dashboards.revoke_connection(self.runtime.capabilities, connection_id)

    def revoke_device_origin(self, origin):
        from openagent_core.mcp.catalog import revoke_interactive_capabilities

        origin_key = (
            origin.device_id,
            origin.client_instance_id,
            origin.generation,
            origin.auth_epoch,
        )
        for namespace in tuple(self._interactive_leases):
            if self._interactive_origins.get(namespace) == origin_key:
                self._interactive_origins.pop(namespace, None)
                leases = self._interactive_leases.pop(namespace)
                revoke_interactive_capabilities(self.runtime.capabilities, leases)
                for lease in leases:
                    self._interactive_sources.pop(lease.source_id, None)

    async def context(self, request: Any, session_id: str):
        identity = await self.authorizer.bind_request(request)
        return await self.authorizer.context_for_identity(identity, session_id)

    async def _capability_context(self, context):
        from openagent_core.core.execution_origin import current_execution_origin
        from openagent_core.mcp.catalog import register_interactive_capabilities

        dashboard_leases = (
            await self.dashboards.leases_for_context(self.runtime.capabilities, context)
            if self.dashboards is not None
            else ()
        )
        origin = current_execution_origin()
        if origin is None:
            return dashboard_leases
        identity = current_on_behalf_identity()
        if identity is None or identity.device_id != origin.device_id:
            raise PermissionError(
                "Capability origin differs from the authenticated device"
            )
        namespace = f"app/{context.ingress_id}/{origin.client_instance_id}/{origin.generation}/{origin.auth_epoch}"
        existing = self._interactive_leases.get(namespace)
        if existing is not None:
            return (*dashboard_leases, *existing)
        leases = register_interactive_capabilities(
            self.runtime.capabilities, origin, source_namespace=namespace
        )
        if hasattr(leases, "__await__"):
            leases = await leases
        for lease in leases:
            self._interactive_sources[lease.source_id] = context.initiator.key
        self._interactive_leases[namespace] = tuple(leases)
        self._interactive_origins[namespace] = (
            origin.device_id,
            origin.client_instance_id,
            origin.generation,
            origin.auth_epoch,
        )
        return (*dashboard_leases, *leases)

    async def _authorize_source(self, context, action, resource, *, audience=()):
        # This policy is host-owned. No MCP row or client-provided ownership
        # field can promote a personal capability into a shared-data source.
        if self.dashboards is not None:
            result = self.dashboards.authorize_source(
                context, action, resource, audience=audience
            )
            if result is not None:
                return result
        if action.startswith("catalog.") or action.startswith("automation."):
            binding = await self.authorizer._binding(context)
            return bool(
                binding is not None
                and binding.identity.auth_kind == "device_cert"
                and context.initiator.kind == "user"
                and context.initiator.subject_id == await self.directory.owner_handle()
            )
        if action in {"model.list", "model.use"}:
            from openagent_core.contracts import ResourceRef

            return await self.authorizer.authorize(
                context,
                "run.read" if action == "model.list" else "run.execute",
                ResourceRef("session", context.tenant_id, context.session_id),
                audience=context.audience,
            )
        if action not in {"tool.discover", "tool.call", "tool.publish"}:
            return False
        source = resource.resource_id
        if resource.kind == "tool":
            source = source.rsplit("/", 1)[0]
        owner = self._interactive_sources.get(source)
        if owner is not None:
            return owner == context.initiator.key and context.audience == (
                context.initiator,
            )
        if context.delegation_id and f"capability:{source}" not in context.scopes:
            return False
        # One catalog owns native module capabilities, external MCPs and
        # product sources. Pool membership is an implementation detail of the
        # optional MCP module and cannot authorize (or hide) the other kinds.
        catalog = getattr(self.runtime, "capabilities", None)
        if catalog is None or not catalog.has_source(source, context):
            return False
        policies = self.agent.config.get("runtime_tool_audiences") or {}
        domain = {"vault-gate": "vault", "skill-data": "skills"}.get(source, source)
        if policies.get(domain) == "installation":
            # This is an explicit sharing decision for this agent's corpus.
            # The network is only the identity directory, never a shared store.
            return all(
                [
                    value.tenant_id == context.tenant_id
                    and await self.directory.principal_active(value)
                    for value in context.audience
                ]
            )
        if domain in {"vault", "skills"}:
            owner = await self.directory.owner_handle()
            return bool(
                owner
                and context.initiator.kind == "user"
                and context.initiator.subject_id == owner
                and context.audience == (context.initiator,)
            )
        return context.audience == (context.initiator,)


@web.middleware
async def bind_runtime_identity(request, handler):
    service = getattr(request.app.get("gateway"), "runtime_service", None)
    if (
        service is not None
        and request.get("device_cert") is not None
        and request.get("auth_kind") in {"device_cert", "agent"}
    ):
        try:
            await service.authorizer.bind_request(request)
        except PermissionError:
            raise web.HTTPForbidden(text="Device authorization changed") from None
    protected = (
        "/api/automations/",
        "/api/scheduled-tasks",
        "/api/events",
        "/api/workflows",
        "/api/workflow-runs",
    )
    if request.path.startswith(protected):
        if service is None:
            raise web.HTTPServiceUnavailable(text="Automation management is not ready")
        from openagent_core.contracts import ResourceRef, require_authorized

        try:
            context = await service.context(request, "__automation_management__")
            await require_authorized(
                service.authorizer,
                context,
                "automation.read" if request.method == "GET" else "automation.manage",
                ResourceRef("automation", context.tenant_id, request.path),
            )
        except PermissionError:
            raise web.HTTPForbidden(
                text="Automation access is not authorized"
            ) from None
    if request.path.startswith(("/api/providers", "/api/models")):
        from openagent_server.provider_management import authorize_request

        await authorize_request(request)
        if request.method not in {"GET", "HEAD"}:
            if not hasattr(service, "provider_admin_lock"):
                service.provider_admin_lock = asyncio.Lock()
            async with service.provider_admin_lock:
                return await handler(request)
    return await handler(request)


def _service(request) -> NativeRuntimeService:
    service = getattr(request.app["gateway"], "runtime_service", None)
    if service is None:
        raise web.HTTPServiceUnavailable(text="Runtime is not accepting work")
    return service


async def handle_submit(request):
    try:
        body = await request.json()
        fields = {
            "run_id",
            "session_id",
            "idempotency_key",
            "input",
            "deadline_seconds",
            "attachments",
            "model_ref",
            "steer_run_id",
        }
        if not isinstance(body, dict) or set(body) - fields:
            raise ValueError("Unexpected run fields")
        if not all(
            isinstance(body.get(key), str) and body[key]
            for key in ("run_id", "session_id", "idempotency_key", "input")
        ):
            raise ValueError("Run, session, idempotency key and input are required")
        attachments = body.get("attachments", [])
        if not isinstance(attachments, list) or any(
            not isinstance(item, dict) for item in attachments
        ):
            raise ValueError("Attachments must be artifact descriptors")
        service = _service(request)
        context = await service.context(request, body["session_id"])
        if attachments:
            from openagent_core.memory.artifacts import normalize_inbound_attachments

            identity = await service.authorizer.bind_request(request)
            attachments = await normalize_inbound_attachments(
                request.app["gateway"].agent.memory_db,
                attachments,
                session_id=body["session_id"],
                principal=service.facade.canonical_access_context(identity),
                allow_local_paths=False,
            )
        candidate = RunRequest(
            body["run_id"],
            body["session_id"],
            body["idempotency_key"],
            body["input"],
            body.get("deadline_seconds"),
            tuple(attachments),
            body.get("model_ref"),
            steer_run_id=body.get("steer_run_id"),
        )
        try:
            accepted = await service.runtime.accepted_request(candidate.run_id, context)
        except LookupError:
            accepted = None
        if accepted is not None:
            if (
                accepted.request != candidate
                or accepted.author != context.author
                or accepted.initiator != context.initiator
            ):
                raise IdempotencyConflict("Request differs from its durable acceptance")
            record = await service.runtime.get_run(candidate.run_id, context)
        else:
            record = await service.runtime.submit(candidate, context)
        return web.json_response(asdict(record), status=202)
    except IdempotencyConflict:
        return web.json_response({"error": "idempotency_conflict"}, status=409)
    except (ValueError, TypeError):
        return web.json_response({"error": "invalid_run_request"}, status=400)
    except PermissionError:
        return web.json_response({"error": "not_authorized"}, status=403)


async def _existing(request):
    service = _service(request)
    run_id = request.match_info["run_id"]
    # Store lookup only finds the resource identity. No run data is returned
    # before the public read authorization below succeeds.
    record = await service.store.get(run_id)
    if record is None:
        raise web.HTTPNotFound()
    try:
        context = await service.context(request, record.session_id)
    except PermissionError:
        raise web.HTTPNotFound() from None
    return service, run_id, context


async def handle_get(request):
    service, run_id, context = await _existing(request)
    try:
        return web.json_response(asdict(await service.runtime.get_run(run_id, context)))
    except PermissionError:
        raise web.HTTPForbidden() from None


async def handle_events(request):
    service, run_id, context = await _existing(request)
    try:
        cursor = int(request.query.get("after", "0"))
        if cursor < 0:
            raise ValueError()
        events = await service.runtime.events(run_id, cursor, context)
        return web.json_response({"events": [asdict(event) for event in events]})
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid event cursor") from None
    except PermissionError:
        raise web.HTTPForbidden() from None


async def handle_cancel(request):
    service, run_id, context = await _existing(request)
    try:
        return web.json_response(asdict(await service.runtime.cancel(run_id, context)))
    except PermissionError:
        raise web.HTTPForbidden() from None
