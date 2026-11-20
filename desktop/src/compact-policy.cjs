(function (root) {
  'use strict';

  // When to compact a conversation before the next message goes out.
  // Once the prompt cache has expired the next send pays full input price for the whole context either way,
  // so compacting then costs about one summary of output and makes that turn and every later one cheaper.
  // While the cache is warm, compacting throws it away, so it only pays near the context limit.
  const HIGH_FRACTION = 0.75;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const STALE_MIN_TOKENS = 40000;
  const STALE_MIN_FRACTION = 0.25;

  const known = (n) => Number.isFinite(n) && n > 0;

  // null, 'high' (near the window limit) or 'stale' (cache expired and the context is big). Unknown usage or
  // window, or an unknown idle time, never triggers: no compaction on a guess.
  function shouldCompact({ usedTokens, windowTokens, idleMs, cacheTtlMs } = {}) {
    if (!known(usedTokens) || !known(windowTokens)) return null;
    if (usedTokens / windowTokens >= HIGH_FRACTION) return 'high';
    const ttl = known(cacheTtlMs) ? cacheTtlMs : CACHE_TTL_MS;
    if (Number.isFinite(idleMs) && idleMs > ttl && usedTokens >= Math.min(STALE_MIN_TOKENS, STALE_MIN_FRACTION * windowTokens)) return 'stale';
    return null;
  }

  const exported = { shouldCompact, HIGH_FRACTION, CACHE_TTL_MS, STALE_MIN_TOKENS, STALE_MIN_FRACTION };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.CompactPolicy = exported;
})(typeof window === 'object' ? window : undefined);
