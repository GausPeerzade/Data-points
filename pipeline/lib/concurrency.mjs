// Keep task results in input order, while allowing up to limit active mappers.
// A failed mapper stops new work; all started work settles before rejection so
// callers can safely report failure without later writes from those mappers.
export async function mapLimit(items, limit, mapper) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
  if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');

  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
  return results;
}
