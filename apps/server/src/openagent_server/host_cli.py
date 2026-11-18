"""Public CLI composition for installed domain adapters using EngineExtensions."""
from __future__ import annotations

import inspect

_FACTORY = '_openagent_engine_extensions_factory'


async def resolve_engine_extensions(factory, configuration, agent_dir):
    """Resolve trusted host composition before starting the stock server."""
    if factory is None:
        return None
    if not callable(factory):
        raise ValueError('The host extension factory must be callable')
    result = factory(configuration=configuration, agent_dir=agent_dir)
    if inspect.isawaitable(result):
        result = await result
    from openagent_core.extensions import EngineExtensions
    if result is not None and not isinstance(result, EngineExtensions):
        raise TypeError('The host factory must return EngineExtensions or None')
    return result


def create_host_cli(*, name='openagent', engine_extensions_factory, excluded_commands=()):
    """Compose stock commands without replacing its server, runner or globals.

    The factory receives keyword arguments `configuration` and `agent_dir`.
    It may return EngineExtensions, None, or an awaitable of either. Domain
    callbacks still use Core's public capability and authorization contracts.
    Each invocation owns its factory; another CLI cannot inherit it.
    """
    import click
    from copy import copy
    from . import cli as stock
    if not callable(engine_extensions_factory):
        raise ValueError('The host extension factory must be callable')
    excluded = frozenset(excluded_commands)
    if excluded - stock.main.commands.keys():
        raise ValueError('Unknown excluded stock command')

    @click.pass_context
    def callback(ctx, *args, **kwargs):
        result = stock.main.callback(*args, **kwargs)
        ctx.obj[_FACTORY] = engine_extensions_factory
        return result

    group = click.Group(name=name, params=[copy(param) for param in stock.main.params], callback=callback, help=stock.main.help)
    for command_name, command in stock.main.commands.items():
        if command_name not in excluded:
            owned = copy(command)
            owned.params = [copy(param) for param in command.params]
            if isinstance(owned, click.Group): owned.commands = dict(command.commands)
            group.add_command(owned, command_name)
    return group
