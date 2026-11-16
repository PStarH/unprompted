// Distribution metadata for a public app build. Owner-private runtime
// configuration keeps using publicClientConfiguration directly.
import { publicClientConfiguration } from '../src/connection-catalog.js';

export const NOTION_CONFIDENTIAL_CLIENT_CODE = 'ERR_NOTION_CONFIDENTIAL_CLIENT';

const NOTION_CONFIDENTIAL_MESSAGE = 'Notion confidential OAuth clients cannot be distributed in a public app. Remove the Notion client secret from the build connector metadata; owner-private Notion credentials stay in the local runtime configuration.';

/** Normalize connector client metadata for a distributed build. A Notion
 * confidential client secret is rejected instead of being bundled; a
 * secretless Notion broker descriptor {clientId, brokerUrl} stays public.
 * Slack's optional secret is removed while its public client ID and redirect
 * URI stay. Returns fresh objects and never mutates the caller's input. */
export function distributionClientConfiguration(input) {
  // Reject the confidential secret before the shared parser so an ambiguous
  // broker+secret pair still reports the distribution-specific error.
  const notionEntry = input && typeof input === 'object' && !Array.isArray(input) ? input.notion : null;
  if (notionEntry && typeof notionEntry === 'object' && !Array.isArray(notionEntry) && notionEntry.clientSecret != null) {
    const error = new Error(NOTION_CONFIDENTIAL_MESSAGE);
    error.code = NOTION_CONFIDENTIAL_CLIENT_CODE;
    throw error;
  }
  const normalized = publicClientConfiguration(input);
  const result = {};
  for (const [id, entry] of Object.entries(normalized)) {
    const published = { ...entry };
    if (id === 'slack') delete published.clientSecret;
    result[id] = published;
  }
  return result;
}
