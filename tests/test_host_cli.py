"""Host CLI composition keeps the stock lifecycle and invocation isolation."""
import asyncio
from pathlib import Path
from unittest.mock import patch

import click
from click.testing import CliRunner
import pytest

from openagent_core.extensions import EngineExtensions
from openagent_server import cli as stock
from openagent_server.host_cli import create_host_cli, resolve_engine_extensions, _FACTORY


@pytest.mark.asyncio
async def test_sync_async_disabled_and_invalid_extension_factories():
    expected=EngineExtensions()
    seen=[]
    def factory(**kwargs):seen.append(kwargs);return expected
    assert await resolve_engine_extensions(factory,{'name':'fixture'},Path('/fixture')) is expected
    assert seen==[{'configuration':{'name':'fixture'},'agent_dir':Path('/fixture')}]
    async def afactory(**kwargs):await asyncio.sleep(0);return expected
    assert await resolve_engine_extensions(afactory,{},None) is expected
    assert await resolve_engine_extensions(None,{},None) is None
    assert await resolve_engine_extensions(lambda **kwargs:None,{},None) is None
    with pytest.raises(TypeError):await resolve_engine_extensions(lambda **kwargs:object(),{},None)
    with pytest.raises(ValueError):await resolve_engine_extensions(object(),{},None)


def test_host_groups_do_not_change_stock_commands_or_leak_factories():
    original=stock.AgentServer
    commands=dict(stock.main.commands)
    first=lambda **kwargs:EngineExtensions()
    second=lambda **kwargs:None
    @click.pass_context
    def configure(ctx,**kwargs):ctx.obj={}
    with patch.object(stock.main,'callback',configure):
        a=create_host_cli(name='host-a',engine_extensions_factory=first,excluded_commands=('update',))
        b=create_host_cli(name='host-b',engine_extensions_factory=second)
        for group,expected in [(a,first),(b,second),(a,first)]:
            @click.command('probe')
            @click.pass_context
            def probe(ctx):assert ctx.obj[_FACTORY] is expected
            group.add_command(probe)
            result=CliRunner().invoke(group,['probe'])
            assert result.exit_code==0,result.exception
    assert stock.AgentServer is original
    assert stock.main.commands==commands
    assert 'update' not in a.commands and 'update' in b.commands
    assert a.commands['serve'] is not stock.serve and b.commands['serve'] is not a.commands['serve']
    with pytest.raises(ValueError):create_host_cli(engine_extensions_factory=None)
    with pytest.raises(ValueError):create_host_cli(engine_extensions_factory=first,excluded_commands=('unknown',))


def test_host_serve_passes_extensions_to_the_stock_server_and_failure_starts_nothing(tmp_path):
    class StopBeforeStart(Exception):pass
    expected=EngineExtensions()
    seen=[]
    def factory(**kwargs):seen.append(kwargs);return expected
    def load(ctx,path):ctx.obj.update(config={'name':'fixture'},config_path=str(tmp_path/'fixture.yaml'))
    host=create_host_cli(engine_extensions_factory=factory)
    with patch.object(stock,'_setup_agent_dir'),patch.object(stock,'setup_logging'),patch.object(stock,'_startup_cleanup'),\
         patch.object(stock,'_reload_context_config',load),patch.object(stock,'_managed_temp_root',return_value=None),\
         patch.object(stock.paths,'get_agent_dir',return_value=None),\
         patch('openagent_server.update_guard.boot_guard',return_value=None),\
         patch.object(stock.AgentServer,'from_config',side_effect=StopBeforeStart) as constructor:
        result=CliRunner().invoke(host,['serve','--no-auto-init'])
    assert isinstance(result.exception,StopBeforeStart),result.exception
    assert len(seen)==1 and seen[0]['configuration']['name']=='fixture'
    assert constructor.call_args.kwargs=={'only_channels':None,'engine_extensions':expected}
    def invalid(**kwargs):return 'invalid extension'
    host=create_host_cli(engine_extensions_factory=invalid)
    with patch.object(stock,'_setup_agent_dir'),patch.object(stock,'setup_logging'),patch.object(stock,'_startup_cleanup'),\
         patch.object(stock,'_reload_context_config',load),patch.object(stock,'_managed_temp_root',return_value=None),\
         patch.object(stock.paths,'get_agent_dir',return_value=None),\
         patch('openagent_server.update_guard.boot_guard',return_value=None),\
         patch.object(stock.AgentServer,'from_config') as constructor:
        result=CliRunner().invoke(host,['serve','--no-auto-init'])
    assert isinstance(result.exception,TypeError),result.exception
    constructor.assert_not_called()
