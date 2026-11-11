export function createLog({ isDebug, sink = console, prefix = "[PerSpaceHistory]" }) {
  const seen = new Set();
  return {
    debug(...args) {
      if (isDebug()) {
        sink.log(prefix, ...args);
      }
    },
    info(...args) {
      sink.info(prefix, ...args);
    },
    warn(...args) {
      sink.warn(prefix, ...args);
    },
    error(...args) {
      sink.error(prefix, ...args);
    },
    errorOnce(tag, error) {
      const key = `${tag}:${error?.message ?? error}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      sink.error(prefix, tag, error);
      return true;
    },
  };
}
