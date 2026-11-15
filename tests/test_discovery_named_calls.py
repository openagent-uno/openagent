"""The server opts its model-facing discovery into named calls for authorized tools."""
import pytest

from openagent_server.bootstrap import discovery_presentation


def test_named_calls_cover_every_authorized_tool_by_default():
    assert discovery_presentation({}).named_calls == "authorized"


def test_the_agent_config_can_keep_named_calls_to_listed_pairs():
    presentation = discovery_presentation({"tool_search": {"named_calls": "listed"}})
    assert presentation.named_calls == "listed"
    assert presentation.named_tools == frozenset()


@pytest.mark.parametrize("config", [{"tool_search": {"named_calls": "everything"}}, {"tool_search": "on"}])
def test_an_invalid_setting_fails_at_startup(config):
    with pytest.raises(ValueError):
        discovery_presentation(config)
