/** Native wrappers can expose the exact provider invocation boundary without
 * putting a callback or authority flag in model-controlled data. */
const nativeFetchBoundaries = new WeakMap();
export function bindModelFetchBoundary(wrapper, dispatch) {
  if (typeof wrapper !== 'function' || typeof dispatch !== 'function') throw new TypeError('A native model fetch boundary needs two functions.');
  nativeFetchBoundaries.set(wrapper, dispatch);
  return wrapper;
}
export function invokeModelFetch(fetchImpl, url, init, onProviderFetch = null) {
  const native = nativeFetchBoundaries.get(fetchImpl);
  if (native) return native(url, init, onProviderFetch);
  onProviderFetch?.();
  return fetchImpl(url, init);
}
