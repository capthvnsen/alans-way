// Tab icons are for the human's tab strip. A model cannot act on them, and a
// fetched icon is a base64 image large enough to dominate a snapshot or action.
function omitIcons(value) {
  if (Array.isArray(value)) return value.map(omitIcons);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'favicon') continue;
    out[key] = omitIcons(item);
  }
  return out;
}

module.exports = { omitIcons };
