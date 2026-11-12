/** OAuth scope names are provider-defined. Keep syntax/size checks independent
 * of a hand-maintained list so new provider permissions do not require code. */
export function oauthScopes(value = []) {
  const list = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length > 100 || list.some(scope => typeof scope !== 'string' || !scope || scope.length > 512 || /[\s"\\\u0000-\u001f\u007f]/.test(scope))) throw Object.assign(new Error('Enter at most 100 valid provider scope names.'), { status: 400 });
  return [...new Set(list)];
}
export const withOAuthScopes = (defaults, additional) => oauthScopes([...oauthScopes(defaults || []), ...oauthScopes(additional || [])]);
