// Check ROI drawing controls and diagram updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoiController } from '../js/rois.js';
import { renderSequenceDiagram } from '../js/sequence-diagram.js';
import { sequences } from '../js/sequences.js';

// A small DOM harness exercises pointer capture and UI events without a browser.
class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.value = '';
    this.classes = new Set(); this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    this.style = { setProperty() {} };
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  toggleAttribute(key, force) {
    const present = force ?? !(key in this.attributes);
    if (present) this.attributes[key] = ''; else delete this.attributes[key];
    return present;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name, event = {}) { this.listeners.get(name)?.(event); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 80, height: 80 }; }
  setPointerCapture(pointer) { this.pointer = pointer; }
  hasPointerCapture(pointer) { return this.pointer === pointer; }
  releasePointerCapture() { this.pointer = null; this.fire('lostpointercapture'); }
}

test('three ROIs can be drawn, renamed, redrawn, deleted and restored per slice', () => {
  const previousDocument = globalThis.document;
  try {
    globalThis.document = new Node();
    document.createElement = tag => new Node(tag);
    document.createElementNS = (_, tag) => new Node(tag);
    const elements = Object.fromEntries(['roi-overlay', 'roi-cancel', 'roi-status',
      'roi-controls', 'roi-list', 'roi-slice-note'].map(id => [id, new Node()]));
    // Match an SVG's initial markup. A .hidden assignment alone cannot clear it.
    elements['roi-overlay'].setAttribute('hidden', '');
    const state = { object: 'brain', slice: 50, showRois: true, sequence: 'SE', parameters: { TR: 1, TE: 0.1 },
      noiseFree: false, roiSets: new Map() };
    const maps = { Rho: new Float32Array(16).fill(1), T1: new Float32Array(16).fill(1),
      T2: new Float32Array(16).fill(0.1), T2Star: new Float32Array(16).fill(0.05) };
    const phantom = { width: 4, height: 4, getSlice: () => maps };
    let controller;
    controller = createRoiController({ state, elements, getPhantom: () => phantom, getRenderer: () => ({ getNoise: () => state.noiseFree ? 0 : 0.01 }),
      onHover() {} });
    controller.update();
    assert.equal('hidden' in elements['roi-overlay'].attributes, false, 'visible SVG must have its hidden attribute removed');
    const draw = slot => {
      controller.start(slot);
      const hitArea = elements['roi-overlay'].children.find(node => 'data-roi-hit-area' in node.attributes);
      assert.equal(hitArea.attributes['pointer-events'], 'all', 'empty image area must receive drawing events');
      const pointer = { pointerId: 1, button: 0, isPrimary: true, preventDefault() {} };
      elements['roi-overlay'].fire('pointerdown', { ...pointer, clientX: 20, clientY: 20 });
      assert.equal(controller.isDrawing, true);
      assert.ok(elements['roi-overlay'].children.some(node => node.tag === 'circle'), 'pressing immediately displays the trace origin');
      for (const [x, y] of [[60, 20], [60, 60], [20, 60]]) elements['roi-overlay'].fire('pointermove', { ...pointer, clientX: x, clientY: y });
      elements['roi-overlay'].fire('pointerup', { ...pointer, clientX: 20, clientY: 20 });
      assert.equal(controller.isDrawing, false);
    };
    for (let slot = 0; slot < 3; slot++) draw(slot);
    const regions = state.roiSets.get('brain:50').regions;
    assert.equal(regions.filter(Boolean).length, 3);
    assert.ok(regions.every(region => region.indices.length === 4));
    const firstRow = elements['roi-list'].children[0];
    const name = firstRow.children.find(child => child.tag === 'input');
    name.value = 'White matter'; name.fire('input');
    assert.equal(regions[0].label, 'White matter');
    assert.equal(elements['roi-list'].children[0], firstRow, 'live updates preserve label input focus');
    draw(0);
    assert.equal(regions[0].label, 'White matter', 'redrawing retains the label');
    controller.start(0);
    document.fire('keydown', { key: 'Escape' });
    assert.equal(regions.filter(Boolean).length, 3, 'cancelling does not erase previous masks');
    state.slice = 51; controller.invalidate(); controller.update();
    assert.equal(state.roiSets.get('brain:51').regions.filter(Boolean).length, 0);
    state.slice = 50; controller.invalidate(); controller.update();
    assert.equal(state.roiSets.get('brain:50').regions.filter(Boolean).length, 3);
    state.sequence = 'GRE'; state.parameters = { TR: 1, TE: 0.1, FA: 90 }; controller.update();
    const originalPlot = controller.getPlot().trace.curves[0].values.slice();
    state.parameters.FA = 30; controller.update();
    assert.notDeepEqual(controller.getPlot().trace.curves[0].values, originalPlot);
    state.parameters.TE = 0.02; controller.update();
    assert.equal(controller.getPlot().trace.sampleTime, 0.020);
    const svg = new Node('svg');
    renderSequenceDiagram(svg, sequences.GRE, state.parameters, controller.getPlot());
    assert.equal(svg.attributes.viewBox, '0 0 900 780');
    const markers = svg.children.filter(node => node.attributes.class === 'roi-image-sample');
    assert.equal(markers.length, 3);
    const samplingLine = svg.children.find(node => node.attributes.class === 'roi-chart-current');
    assert.ok(markers.every(marker => marker.attributes.cx === samplingLine.attributes.x1));
    const deleteButton = elements['roi-list'].children[0].children.find(node => node.attributes['aria-label'] === 'Delete ROI 1');
    deleteButton.fire('click');
    assert.equal(regions.filter(Boolean).length, 2);
    state.showRois = false; controller.update();
    assert.equal('hidden' in elements['roi-overlay'].attributes, true);
    state.showRois = true; controller.update();
    assert.equal('hidden' in elements['roi-overlay'].attributes, false);
    const hitArea = elements['roi-overlay'].children.find(node => 'data-roi-hit-area' in node.attributes);
    assert.equal(hitArea.attributes['pointer-events'], 'none', 'idle overlay lets canvas hover events through');
    assert.equal(regions.filter(Boolean).length, 2);
    renderSequenceDiagram(svg, sequences.GRE, state.parameters, controller.getPlot());
    for (const path of svg.children.filter(node => node.tag === 'path')) {
      assert.ok(!/NaN|undefined|Infinity/.test(path.attributes.d));
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('ROI plots stay linear within the signal window and align sampling at TI + TE for IR', () => {
  const previousDocument = globalThis.document;
  try {
    globalThis.document = { createElementNS: (_, tag) => new Node(tag) };
    const parameters = { TR: 5, TE: 0.08, TI: 1.2 };
    const plot = { trace: { values: new Float64Array([0, 1.2, 1.28, 1.45]), curves: [{
      region: { slot: 0, color: '#ffbc55', label: 'Test ROI' }, values: new Float64Array([0.8, 0.6, 0.4, 0.1]), signedValues: new Float64Array([-0.8, 0.6, 0.4, 0.1]),
    }] }, means: new Map([[0, 0.4]]) };
    const svg = new Node('svg');
    renderSequenceDiagram(svg, sequences.IR, parameters, plot);
    const marker = svg.children.find(node => node.attributes.class === 'roi-image-sample');
    const echoLine = svg.children.find(node => node.attributes.class === 'diagram-echo-marker');
    assert.equal(marker.attributes.cx, echoLine.attributes.x1);
    const curves = svg.children.filter(node => node.attributes.class === 'roi-signal-curve');
    assert.equal(curves.length, 2);
    assert.equal(curves[0].attributes.stroke, curves[1].attributes.stroke);
    assert.equal(curves[0].attributes['stroke-dasharray'], undefined);
    assert.equal(curves[1].attributes['stroke-dasharray'], '2 6');
    assert.ok(svg.children.some(node => node.tag === 'text' && /^-0\./.test(node.textContent)));
    const coordinates = curves[0].attributes.d.match(/[ML] ([\d.]+) ([\d.]+)/g).map(point => point.split(' ').slice(1).map(Number));
    assert.equal(coordinates[0][0], 110);
    assert.ok(Math.abs((coordinates[2][0] - coordinates[1][0]) / (coordinates[1][0] - coordinates[0][0]) - 0.08 / 1.2) < 1e-4);

    assert.ok(svg.children.some(node => node.textContent?.includes('Image sampling at t = 1.280 s')));
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('180-degree RF labels sit above the inversion and refocusing pulse peaks', () => {
  const previousDocument = globalThis.document;
  try {
    globalThis.document = { createElementNS: (_, tag) => new Node(tag) };
    const svg = new Node('svg');
    renderSequenceDiagram(svg, sequences.IR, { TR: 5, TE: 0.08, TI: 1.2 });
    const labels = svg.children.filter(node => node.tag === 'text' && node.textContent === '180°');
    assert.equal(labels.length, 3);
    assert.ok(labels.every(label => Number(label.attributes.y) <= 101));
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});
