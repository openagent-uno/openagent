"""Pooled provider credentials (metadata.accounts) never leave the gateway."""
from openagent_server.gateway.api.providers import _shape_provider


def test_pooled_account_keys_are_masked_and_the_row_is_untouched():
    row = {"id": 1, "name": "relay", "framework": "api-based", "api_key": "primary-secret-key", "enabled": True,
           "metadata": {"pool_strategy": "fill_first", "accounts": [
               {"api_key": "pooled-secret-one", "label": "work", "priority": 2},
               {"api_key": "${POOLED_ENV}", "base_url": "http://other.test/v1"}, "unexpected"]}}
    shaped = _shape_provider(row)
    assert "pooled-secret" not in repr(shaped) and "primary-secret" not in repr(shaped)
    assert shaped["metadata"]["accounts"][0] == {"label": "work", "priority": 2, "api_key_display": "****-one"}
    assert shaped["metadata"]["accounts"][1]["api_key_display"] == "${POOLED_ENV}"
    assert shaped["metadata"]["accounts"][2] == "unexpected"
    assert shaped["metadata"]["pool_strategy"] == "fill_first"
    assert row["metadata"]["accounts"][0]["api_key"] == "pooled-secret-one"


def test_rows_without_a_pool_keep_their_metadata():
    assert _shape_provider({"id": 2, "name": "plain", "framework": "api-based", "metadata": {"note": "x"}})["metadata"] == {"note": "x"}
    assert _shape_provider({"id": 3, "name": "bare", "framework": "api-based"})["metadata"] == {}
