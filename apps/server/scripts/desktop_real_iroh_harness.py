#!/usr/bin/env python3
"""Opt-in real-Iroh server harness for the Desktop Playwright E2E.

The harness owns the server half of one isolated acceptance run:

* a temporary coordinator database and identity;
* the production Gateway and coordinator services over a real Iroh node;
* a one-use ``oa1`` user invitation consumed by the real Electron client;
* the production Agent/runtime tool loop backed by a deterministic local
  OpenAI-compatible endpoint.

It prints one ``OPENAGENT_DESKTOP_IROH_READY {...}`` line, then remains alive
until stdin closes or receives ``stop``.  The Playwright process owns the
temporary root and can therefore inspect the client-local sentinel and model
transcript before removing it.  No public TCP Gateway or synthetic auth token
is involved: Electron enrolls its own device identity and every chat/tool
stream crosses its native Iroh loopback.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import threading
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any


READY_PREFIX = "OPENAGENT_DESKTOP_IROH_READY "
SERVER_ROOT = Path(__file__).resolve().parents[1]
# Executing ``python scripts/<name>.py`` places ``scripts/`` rather than the
# repository root on sys.path.  Add the root explicitly so both ``src`` and
# the reusable test fixture package resolve identically in local and CI runs.
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


async def _wait_for_stop() -> None:
    """Wait for the owning Playwright process, stdin EOF, or a signal."""

    loop = asyncio.get_running_loop()
    stopped = asyncio.Event()
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        with suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stopped.set)

    # A cancelled ``asyncio.to_thread(sys.stdin.readline)`` remains inside the
    # loop's default executor and can make ``asyncio.run`` hang forever while
    # stdin is still open. A tiny daemon reader gives stdin EOF/"stop" the same
    # wakeup semantics without making signal-driven shutdown wait on that OS
    # thread (notably on Windows, where add_reader is unavailable).
    loop = asyncio.get_running_loop()

    def read_stdin() -> None:
        try:
            sys.stdin.readline()
        finally:
            with suppress(RuntimeError):
                loop.call_soon_threadsafe(stopped.set)

    threading.Thread(
        target=read_stdin,
        name="desktop-real-iroh-harness-stdin",
        daemon=True,
    ).start()
    await stopped.wait()


async def _persist_model_evidence(
    path: Path,
    calls: list[dict[str, Any]],
) -> None:
    """Expose deterministic-provider inputs without adding a test HTTP API."""

    previous = -1
    try:
        while True:
            if len(calls) != previous:
                _atomic_json(path, calls)
                previous = len(calls)
            await asyncio.sleep(0.025)
    finally:
        _atomic_json(path, calls)


async def _seed_deterministic_model(db: Any, model_base_url: str) -> None:
    """Register the harness provider in the canonical dispatch catalog."""

    provider_id = await db.upsert_provider(
        name="local",
        framework="api-based",
        api_key="local",
        base_url=model_base_url,
        enabled=True,
    )
    await db.upsert_model(
        provider_id=provider_id,
        model="deterministic-client-e2e",
        display_name="Deterministic Client E2E",
        enabled=True,
    )


async def run(root: Path) -> None:
    from aiohttp import web
    import ast
    from openagent_core.core.paths import set_agent_dir
    from openagent_modules.legacy import module_pool
    from openagent_server.server import AgentServer
    from openagent_identity.coordinator.store import CoordinatorStore
    from openagent_identity.ticket import InviteTicket

    root=root.resolve();root.mkdir(parents=True,exist_ok=True);set_agent_dir(root)
    target=root/'desktop-machine'/'sentinel.txt';target.parent.mkdir(parents=True,exist_ok=True)
    evidence_path=root/'model-calls.json';calls=[];_atomic_json(evidence_path,calls)
    def data(text):
        try:return json.loads(text)
        except ValueError:return ast.literal_eval(text)
    async def complete(request):
        payload=await request.json();calls.append(payload);_atomic_json(evidence_path,calls)
        messages=payload.get('messages',[])
        start=max((i for i,m in enumerate(messages) if m.get('role')=='user' and ('Desktop Iroh sentinel' in str(m.get('content','')) or 'cli: fixture' in str(m.get('content','')))),default=0)
        cli_turn = 'cli: fixture' in str(messages[start].get('content',''))
        results=[data(m['content']) for m in messages[start:] if m.get('role')=='tool']
        call=None;final='desktop file read failed'
        if payload.get('tools'):
            if not results:call=('tool_search_list_servers',{})
            elif cli_turn:
                if any(source['source_ref'].startswith(('app/','app-dashboard/')) for source in results[0]):
                    raise web.HTTPConflict(text='CLI inherited an unrelated App capability')
                final='CLI fixture complete'
            elif len(results)==1:
                sources=[source for source in results[0] if source['source_ref'].endswith('/filesystem')]
                if len(sources)!=1:raise web.HTTPConflict(text='Expected exactly one originating filesystem')
                call=('tool_search_list_tools',{'source_ref':sources[0]['source_ref']})
            elif len(results)==2:
                ref=next(tool['tool_ref'] for tool in results[1] if tool['name']=='write_file')
                call=('tool_search_call_tool',{'tool_ref':ref,'args':{'path':str(target),'content':'desktop-sentinel'}})
            elif len(results)==3 and not results[-1].get('isError'):
                ref=next(tool['tool_ref'] for tool in results[1] if tool['name']=='read_text_file')
                call=('tool_search_call_tool',{'tool_ref':ref,'args':{'path':str(target)}})
            elif len(results)>=4 and not results[-1].get('isError') and 'desktop-sentinel' in json.dumps(results[-1]):
                final='desktop file written'
        elif 'response_format' in payload:final=json.dumps({'summary':'Desktop fixture complete','topics':['desktop']})
        message={'role':'assistant'}
        if call:
            message['tool_calls']=[{'index':0,'id':'desktop-fixture-'+str(len(calls)),'type':'function','function':{'name':call[0],'arguments':json.dumps(call[1])}}]
            reason='tool_calls'
        else:message['content']=final;reason='stop'
        if payload.get('stream'):
            response=web.StreamResponse(headers={'Content-Type':'text/event-stream'});await response.prepare(request)
            for delta,finish in ((message,None),({},reason)):
                chunk={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'deterministic-client-e2e','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
                await response.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            await response.write(b'data: [DONE]\n\n');await response.write_eof();return response
        for item in message.get('tool_calls',[]):item.pop('index',None)
        return web.json_response({'id':'fixture','object':'chat.completion','created':1,'model':'deterministic-client-e2e','choices':[{'index':0,'message':message,'finish_reason':reason}],
            'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})

    model_app=web.Application();model_app.router.add_post('/v1/chat/completions',complete)
    model_runner=web.AppRunner(model_app);await model_runner.setup()
    model_site=web.TCPSite(model_runner,'127.0.0.1',0);await model_site.start()
    model_base_url='http://127.0.0.1:'+str(model_site._server.sockets[0].getsockname()[1])+'/v1'
    server=AgentServer.from_config({'name':'coordinator','_local_e2e':True,'memory':{'db_path':str(root/'gateway.db')},'channels':{},'voice':{'prefetch':False}})
    db=server.agent.memory_db;await db.connect();store=CoordinatorStore(db)
    network_id='desktop-real-iroh-'+uuid.uuid4().hex[:12];network_name='desktop-real-iroh-e2e'
    await store.set_network_role(role='coordinator',network_id=network_id,name=network_name)
    await _seed_deterministic_model(db,model_base_url)
    server.agent.set_capability_pool(module_pool((),db_path=db.db_path))
    await server.agent.load_model_catalog();await db.close()
    try:
        await server.start();state=server._network_state
        coordinator_node_id=await state.node_id()
        handle='desktop-e2e';password='desktop-real-iroh-password'
        await store.register_agent(handle='coordinator',node_id=coordinator_node_id,owner_handle=handle,label='Desktop Real Iroh E2E')
        relay_url,addresses=await state.iroh_node.local_node_addr()
        invitation=await store.create_invitation(role='user',created_by='desktop-real-iroh-playwright',ttl_seconds=900,uses=1,bind_to_handle=handle)
        ticket=InviteTicket(code=invitation.code,coordinator_node_id=coordinator_node_id,network_name=network_name,network_id=network_id,role='user',bind_to='',relay_url=relay_url,addresses=tuple(addresses) or None).encode()
        print(READY_PREFIX+json.dumps({'ticket':ticket,'password':password,'handle':handle,'network_id':network_id,'coordinator_node_id':coordinator_node_id,'target_path':str(target),'evidence_path':str(evidence_path)},sort_keys=True),flush=True)
        await _wait_for_stop()
    finally:
        await server.stop();await model_runner.cleanup();set_agent_dir(None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        required=True,
        help="Playwright-owned isolated state/evidence directory",
    )
    args = parser.parse_args()
    asyncio.run(run(args.root))


if __name__ == "__main__":
    main()
