// Each key's promise, made once. A failure is not the answer for next time
export function promiseCache<V>() {
  const promises = new Map<string, Promise<V>>();
  return (key: string, make: () => Promise<V>): Promise<V> => {
    let promise = promises.get(key);
    if (!promise) {
      promise = make();
      promises.set(key, promise);
      promise.catch(() => promises.delete(key));
    }
    return promise;
  };
}
