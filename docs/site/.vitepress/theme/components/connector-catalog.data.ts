import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface OfficialConnector {
  id: string;
  name: string;
  description: string;
  category: string;
}

declare const data: OfficialConnector[];
export { data };

export default {
  async load(): Promise<OfficialConnector[]> {
    const lockPath = new URL('../../../../../apps/server/src/openagent_server/connectors.lock.json', import.meta.url);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const asset = lock.assets['catalog.json'];
    const url = `https://github.com/${lock.source_repository}/releases/download/${lock.source_ref}/catalog.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Connector catalog download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new Error('Connector catalog does not match the product lock');
    }

    const catalog: (OfficialConnector & { nativeKind?: string })[] = JSON.parse(bytes.toString('utf8'));
    // Match the app's official connector catalog and publish only listing fields.
    return catalog.filter(item => !item.nativeKind).map(({ id, name, description, category }) => ({
      id, name, description, category,
    }));
  },
};
