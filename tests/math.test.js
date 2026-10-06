// Check equation loading and rendering with a small DOM stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLatex } from '../js/math.js';

test('direct LaTeX conversion installs output styles once and keeps only the latest equation', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const stylesheet = { isConnected: false };
  const inserted = [];
  const rendered = [];
  let script;
  const element = () => ({
    textContent: '',
    setAttribute() {}, removeAttribute() {},
    replaceChildren(node) {
      assert.ok(stylesheet.isConnected, 'SVG and assistive MathML styles must exist before display');
      this.children = [node];
    },
  });
  try {
    globalThis.window = {};
    globalThis.document = {
      createElement() { return {}; },
      head: { append(node) {
        inserted.push(node);
        if (node === stylesheet) node.isConnected = true;
        else script = node;
      } },
    };
    const signal = element();
    const display = element();
    const first = renderLatex(signal, 'old sequence');
    const latest = renderLatex(signal, 'new sequence');
    const magnitude = renderLatex(display, 'magnitude');
    window.MathJax = {
      startup: { promise: Promise.resolve() },
      tex2svg(latex) { rendered.push(latex); return { latex }; },
      svgStylesheet() { return stylesheet; },
    };
    script.onload();
    await Promise.all([first, latest, magnitude]);
    assert.deepEqual(rendered, ['new sequence', 'magnitude']);
    assert.deepEqual(signal.children, [{ latex: 'new sequence' }]);
    assert.deepEqual(display.children, [{ latex: 'magnitude' }]);
    assert.equal(inserted.filter(node => node === stylesheet).length, 1);
    await renderLatex(signal, 'another sequence');
    assert.equal(inserted.filter(node => node === stylesheet).length, 1);
    assert.deepEqual(signal.children, [{ latex: 'another sequence' }]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});
