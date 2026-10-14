from unittest.mock import AsyncMock, patch

import pytest

from openagent_cli.connectors import connect


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
