"""Owned MCP acceptance peer. No daemon, remote endpoint, credentials or browser."""
from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
import sys
from typing import TypedDict
from mcp.server.fastmcp import FastMCP

name, root_name, html_name = sys.argv[1:4]
root, html_path = Path(root_name), Path(html_name)
root.mkdir(parents=True, exist_ok=True)
(root / f'{name}.pid').write_text(str(os.getpid()))
URI = 'ui://fixture/shared'
mcp = FastMCP(name)
count = 0

def record(kind, **values):
    with (root / f'{name}.jsonl').open('a') as out:
        out.write(json.dumps({'server': name, 'kind': kind, **values}) + '\n')

class Counter(TypedDict):
    count: int
    server: str

@mcp.tool(meta={'ui': {'resourceUri': URI}})
def show() -> Counter:
    return {'count': count, 'server': name}

@mcp.tool()
def increment(by: int = 1) -> Counter:
    global count
    count += by
    record('increment', by=by, count=count)
    return {'count': count, 'server': name}

if name == 'beta':
    @mcp.tool()
    def beta_only() -> str:
        record('beta_only')
        return 'must not execute from alpha'

@mcp.resource(URI, mime_type='text/html;profile=mcp-app')
async def resource() -> str:
    record('resource')
    if (root / f'{name}.hold').exists():
        await asyncio.sleep(20)
    return html_path.read_text() + '<script>document.body.dataset.fixtureSource=' + json.dumps(name) + '</script>'

mcp.run(transport='stdio')
