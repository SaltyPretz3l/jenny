// Web-search provider selection settings; provider API keys live in SecureStore, never config state.

const WEB_SEARCH_PROVIDER_IDS = Object.freeze([
  'duckduckgo',
  'searxng',
  'brave',
  'tavily',
  'serper',
  'google_pse',
]);

function normalizeWebSearchSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const provider = String(source.provider || '').trim().toLowerCase();
  const searxngUrl = typeof source.searxngUrl === 'string'
    ? source.searxngUrl.trim()
    : typeof source.searxng_url === 'string'
      ? source.searxng_url.trim()
      : '';
  return {
    provider: WEB_SEARCH_PROVIDER_IDS.includes(provider) ? provider : 'duckduckgo',
    searxngUrl,
  };
}

module.exports = {
  WEB_SEARCH_PROVIDER_IDS,
  normalizeWebSearchSettings,
};
