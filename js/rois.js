// Handle ROI drawing, labels, and plots for each slice.
import { rasterizePolygon, sampleRegion, meanMagnitude, meanSigned, traceRegions } from './roi-analysis.js';
import { sequences } from './sequences.js';

const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#ffbc55', '#53bde9', '#f18ec3'];
const svgNode = (tag, attributes, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createRoiController({ state, elements, getPhantom, getRenderer, onHover, onPlot }) {
  const overlay = elements['roi-drawing-overlay'];
  const savedOverlay = elements['roi-overlay'];
  let target = null, draft = null, pointer = null;
  let context = '', listContext = '', generation = 0, cachedKey = '', cachedTrace;
  let rows = [];
  let currentPlot = null;
  const key = () => `${state.object}:${state.slice}`;
  const currentSet = () => {
    if (!state.roiSets.has(key())) state.roiSets.set(key(), { regions: [null, null, null], labels: ['ROI 1', 'ROI 2', 'ROI 3'] });
    return state.roiSets.get(key());
  };
  const status = message => { elements['roi-status'].textContent = message; };

  function cancelDrawing() {
    if (pointer !== null && overlay.hasPointerCapture(pointer)) overlay.releasePointerCapture(pointer);
    target = null; draft = null; pointer = null;
    overlay.classList.remove('drawing');
    elements['roi-cancel'].disabled = true;
    drawOverlay();
  }

  function start(slot) {
    if (!state.showRois || !getPhantom()) return;
    cancelDrawing();
    target = slot;
    overlay.classList.add('drawing');
    drawOverlay();
    elements['roi-cancel'].disabled = false;
    status('');
  }

  // Keep ROI boundaries in phantom pixel coordinates.
  function drawOverlay() {
    overlay.replaceChildren();
    savedOverlay.replaceChildren();
    const phantom = getPhantom();
    const regions = phantom ? currentSet().regions.filter(Boolean) : [];
    // SVGElement has no HTMLElement.hidden setter: change the attribute itself.
    // Saved outlines depend only on region data, never on editor visibility.
    savedOverlay.toggleAttribute('hidden', !phantom || !regions.length);
    overlay.toggleAttribute('hidden', !phantom || !state.showRois);
    if (!phantom) return;
    overlay.setAttribute('viewBox', `0 0 ${phantom.width} ${phantom.height}`);
    savedOverlay.setAttribute('viewBox', `0 0 ${phantom.width} ${phantom.height}`);
    // Receive drawing events even where the SVG has no painted ROI yet.
    overlay.append(svgNode('rect', {
      x: 0, y: 0, width: phantom.width, height: phantom.height, fill: 'transparent',
      'pointer-events': target === null ? 'none' : 'all', 'data-roi-hit-area': '',
    }));
    for (const region of regions) {
      savedOverlay.append(svgNode('polygon', {
        points: region.points.map(point => `${point.x},${point.y}`).join(' '),
        fill: region.color, 'fill-opacity': 0.15, stroke: region.color,
        'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke',
      }));
      const first = region.points[0];
      savedOverlay.append(svgNode('text', { x: Math.min(first.x, phantom.width - 5), y: Math.max(4, first.y - 1),
        fill: region.color, class: 'roi-overlay-label' }, String(region.slot + 1)));
    }
    if (draft && draft.length > 1) overlay.append(svgNode('polyline', {
      points: draft.map(point => `${point.x},${point.y}`).join(' '),
      fill: 'none', stroke: COLORS[target], 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke',
    }));
    if (draft?.length) overlay.append(svgNode('circle', {
      cx: draft[0].x, cy: draft[0].y, r: 0.8, fill: COLORS[target], 'pointer-events': 'none',
    }));
  }

  function coordinate(event) {
    const phantom = getPhantom(), bounds = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(phantom.width, (event.clientX - bounds.left) / bounds.width * phantom.width)),
      y: Math.max(0, Math.min(phantom.height, (event.clientY - bounds.top) / bounds.height * phantom.height)),
    };
  }

  overlay.addEventListener('pointerdown', event => {
    if (target === null || !getPhantom() || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    pointer = event.pointerId;
    overlay.setPointerCapture(pointer);
    draft = [coordinate(event)];
    drawOverlay();
  });
  overlay.addEventListener('pointermove', event => {
    onHover(event);
    if (!draft || event.pointerId !== pointer) return;
    const point = coordinate(event), last = draft.at(-1);
    if (Math.hypot(point.x - last.x, point.y - last.y) < 0.3) return;
    draft.push(point);
    if (draft.length > 2048) draft = draft.filter((_, i) => i % 2 === 0);
    drawOverlay();
  });
  overlay.addEventListener('pointerup', event => {
    if (!draft || event.pointerId !== pointer) return;
    const phantom = getPhantom();
    draft.push(coordinate(event));
    const indices = rasterizePolygon(draft, phantom.width, phantom.height);
    if (!indices.length) {
      draft = null;
      pointer = null;
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
      drawOverlay();
      status('Press and drag to trace a region, then release. A single click does not enclose pixels.');
      return;
    }
    const set = currentSet();
    set.regions[target] = {
      slot: target, label: set.labels[target] || `ROI ${target + 1}`, color: COLORS[target],
      points: draft, indices, maps: sampleRegion(phantom.getSlice(state.slice), indices),
      noise: new Float32Array(indices.length), buffer: new Float32Array(indices.length),
    };
    generation++;
    listContext = '';
    cancelDrawing();
    update();
    status(`Region saved: ${indices.length} pixels. The plot shows signal over time, with image sampling at TE.`);
  });
  overlay.addEventListener('pointercancel', cancelDrawing);
  overlay.addEventListener('lostpointercapture', () => { if (draft) cancelDrawing(); });
  overlay.addEventListener('pointerleave', event => { if (!draft) onHover(event, true); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && target !== null) { cancelDrawing(); status('Drawing cancelled. Existing regions are retained.'); }
  });
  elements['roi-cancel'].addEventListener('click', () => { cancelDrawing(); status('Drawing cancelled.'); });

  function buildRows() {
    elements['roi-list'].replaceChildren();
    rows = [];
    const set = currentSet();
    for (let slot = 0; slot < 3; slot++) {
      const region = set.regions[slot];
      const row = document.createElement('div');
      row.className = 'roi-row';
      row.style.setProperty('--roi-color', COLORS[slot]);
      const label = document.createElement('label');
      label.htmlFor = `roi-name-${slot}`;
      label.className = 'roi-name-label';
      label.textContent = String(slot + 1);
      const name = document.createElement('input');
      name.type = 'text'; name.id = label.htmlFor;
      name.maxLength = 40; name.value = set.labels[slot];
      name.setAttribute('aria-label', `Name of ROI ${slot + 1}`);
      name.addEventListener('input', () => {
        set.labels[slot] = name.value;
        if (set.regions[slot]) set.regions[slot].label = name.value.trim() || `ROI ${slot + 1}`;
        update();
      });
      const draw = document.createElement('button');
      draw.type = 'button'; draw.id = `roi-draw-${slot}`; draw.textContent = region ? 'Redraw' : 'Draw';
      draw.setAttribute('aria-label', `Draw ROI ${slot + 1}`);
      draw.addEventListener('click', () => start(slot));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.disabled = !region;
      remove.setAttribute('aria-label', `Delete ROI ${slot + 1}`);
      remove.addEventListener('click', () => {
        cancelDrawing(); set.regions[slot] = null; generation++; listContext = ''; update();
        status('Region deleted.');
      });
      const value = document.createElement('output');
      value.className = 'roi-current-value'; value.id = `roi-value-${slot}`;
      row.append(label, name, draw, remove, value);
      elements['roi-list'].append(row);
      rows.push(value);
    }
  }

  // Reuse curves until the ROI or simulation inputs change.
  function update(notify = true) {
    elements['roi-slice-note'].textContent = `Draw up to three regions. Regions belong to slice ${state.slice}; returning to a slice restores its regions.`;
    const phantom = getPhantom();
    elements['roi-controls'].disabled = !phantom;
    // Collapsing the editor stops drawing; saved regions still drive the diagram.
    if (!state.showRois) cancelDrawing();
    if (!phantom) { currentPlot = null; drawOverlay(); status('Load a simulation object to draw regions.'); return; }
    if (context !== key()) {
      cancelDrawing(); context = key(); listContext = ''; cachedKey = '';
      status('');
    }
    const sequence = sequences[state.sequence];
    const set = currentSet();
    const currentList = `${key()}:${generation}`;
    if (listContext !== currentList) { buildRows(); listContext = currentList; }
    drawOverlay();
    updatePlot();
    rows.forEach((output, slot) => {
      const region = set.regions[slot], mean = currentPlot?.means.get(slot);
      output.textContent = region ? `${region.indices.length} pixels · Mean ${Number.isFinite(mean) ? mean.toPrecision(5) : 'undefined'} a.u.` : 'Not drawn';
    });
    if (notify) onPlot?.();
  }

  // Plot data belongs to saved regions, independently of the editor lifecycle.
  function updatePlot() {
    if (!getPhantom()) { currentPlot = null; cachedKey = ''; return; }
    const curveKey = JSON.stringify([key(), generation, state.sequence, state.noiseFree, state.parameters]);
    if (cachedKey === curveKey) return;
    const sequence = sequences[state.sequence];
    const regions = currentSet().regions.filter(Boolean);
    for (const region of regions) {
      for (let i = 0; i < region.indices.length; i++) region.noise[i] = getRenderer().getNoise(region.indices[i]);
    }
    cachedTrace = traceRegions(sequence, state.parameters, regions, state.noiseFree);
    cachedKey = curveKey;
    const means = new Map(), signedMeans = new Map();
    for (const region of regions) {
      sequence.simulate(region.maps, state.parameters, region.buffer);
      means.set(region.slot, meanMagnitude(region.buffer, region.noise, state.noiseFree));
      signedMeans.set(region.slot, meanSigned(region.buffer, region.noise, state.noiseFree));
    }
    currentPlot = regions.length ? { trace: cachedTrace, means, signedMeans } : null;
  }

  return {
    update, start, cancelDrawing,
    getPlot() { updatePlot(); return currentPlot; },
    invalidate() { cachedKey = ''; },
    get isDrawing() { return draft !== null; },
  };
}
