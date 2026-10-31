/**
 * Static-page templating. Pages read their data from
 * <script type="application/json" id="data">/*__DATA__*\/null</script>
 * and render it with textContent, so nothing injected is ever parsed as HTML.
 */
const PLACEHOLDER = '/*__DATA__*/null';

/**
 * @param {string} template HTML containing the placeholder exactly once
 * @param {unknown} data    JSON-serializable page data
 */
export function injectJson(template, data) {
  const count = template.split(PLACEHOLDER).length - 1;
  if (count !== 1) throw new Error(`Template must contain ${PLACEHOLDER} exactly once (found ${count}).`);
  // Escaping "<" keeps a "</script>" inside the data from closing the block early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return template.replace(PLACEHOLDER, () => json);
}
