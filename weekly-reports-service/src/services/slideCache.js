// Tiny in-memory LRU for slide images, so flipping back and forth does not re-read S3 each time.
// Authorization always runs BEFORE the cache is consulted (see the slide route), so a cached image
// is only ever handed to a caller who is allowed to see that report.
function buildSlideCache(max) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

module.exports = { buildSlideCache };
