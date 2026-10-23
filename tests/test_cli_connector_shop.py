from unittest.mock import AsyncMock, patch

import pytest

# The CLI is its own component (apps/cli); the server environment the root
# suite runs in does not install it. See pytest.ini for the setup.
connectors = pytest.importorskip(
    "openagent_cli.connectors",
    reason="openagent_cli is not installed: uv pip install --python apps/server/.venv -e apps/cli",
)
connect = connectors.connect


@pytest.mark.asyncio
async def test_cli_shopify_setup_passes_canonical_store_without_credentials():
    client = AsyncMock()
    client.rest_get.return_value = {'connectors': [{'id': 'shopify', 'auth': 'oauth', 'available': True}]}
    client.rest_post.return_value = {'connection': {'id': 'fixture'}}
    with patch('openagent_cli.connectors.Prompt.ask', return_value='  QA-Store.myshopify.com  '), \
         patch('openagent_cli.connectors.authorize', new_callable=AsyncMock) as authorize:
        await connect(client, 'shopify', False, object())
    client.rest_post.assert_awaited_once_with('/api/connectors', {
        'catalog_id': 'shopify', 'allow_write': False, 'config': {'shop': 'qa-store.myshopify.com'}})
    authorize.assert_awaited_once()
