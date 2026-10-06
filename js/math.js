// Only load the locally bundled renderer when the equation panel is requested.
let loading;
const revisions = new WeakMap();

function loadMathJax() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.MathJax = {
      loader: { load: [] },
      startup: { typeset: false },
      tex: { packages: ['base', 'ams'] },
      svg: { fontCache: 'local' },
      options: { enableMenu: false },
    };
    const script = document.createElement('script');
    script.src = new URL('./vendor/mathjax/tex-svg.js', import.meta.url).href;
    script.onload = () => window.MathJax.startup.promise.then(() => resolve(window.MathJax), reject);
    script.onerror = () => {
      script.remove();
      loading = undefined;
      reject(new Error('Equation renderer could not be loaded.'));
    };
    document.head.append(script);
  });
  return loading;
}

// Ignore stale renders when the selected equation changes.
export async function renderLatex(element, latex) {
  const revision = (revisions.get(element) ?? 0) + 1;
  revisions.set(element, revision);
  element.setAttribute('aria-busy', 'true');
  element.textContent = 'Formatting equation…';
  try {
    const mathJax = await loadMathJax();
    if (revisions.get(element) !== revision) return;
    const equation = mathJax.tex2svg(latex, { display: true });
    // Direct conversion does not insert MathJax's output stylesheet. It also
    // supplies the clipping rules for the screen-reader-only MathML copy.
    const stylesheet = mathJax.svgStylesheet();
    if (!stylesheet.isConnected) document.head.append(stylesheet);
    element.replaceChildren(equation);
  } catch {
    if (revisions.get(element) !== revision) return;
    element.textContent = latex;
    element.title = 'Equation renderer unavailable. Showing LaTeX source.';
  } finally {
    if (revisions.get(element) === revision) element.removeAttribute('aria-busy');
  }
}
