// Connect controls, image rendering, and optional panels.
import { sequences, defaultParameters } from './sequences.js';
import { loadPhantom, simulationObjects } from './phantom.js';
import { createRenderer } from './renderer.js';
import { pixelAt } from './pixel.js';
import { renderLatex } from './math.js';
import { renderSequenceDiagram } from './sequence-diagram.js';
import { createRoiController } from './rois.js';

const state = { object: 'brain', sequence: 'SE', slice: 50, parameters: defaultParameters(sequences.SE), darkMode: true, showEquations: false, showDiagram: false, noiseFree: false,
  showRois: false, roiSets: new Map() };
const elements = Object.fromEntries(['object', 'image-object', 'sequence', 'parameters', 'slice', 'slice-value', 'sequence-description',
  'simulation-controls', 'mri-image', 'image-sequence', 'image-slice', 'status', 'loading', 'load-message',
  'retry', 'reset', 'dark-mode', 'show-equations', 'noise-free', 'equations-panel', 'lab', 'image-stage',
  'equation-sequence', 'signal-equation', 'display-equation', 'pixel-position', 'pixel-signal', 'pixel-magnitude',
  'pixel-noise', 'pixel-gray', 'pixel-rho', 'pixel-t1', 'pixel-t2', 'pixel-t2star',
  'show-diagram', 'diagram-panel', 'diagram-number', 'diagram-sequence', 'sequence-diagram', 'diagram-notes', 'diagram-signal-description',
  'define-rois', 'roi-panel', 'roi-overlay', 'image-plane', 'roi-list', 'roi-controls', 'roi-cancel',
  'roi-slice-note', 'roi-status', 'equation-number'].map(id => [id, document.getElementById(id)]));
let phantom;
const loadedObjects = new Map();
let signal;
let renderer;
let pendingFrame = null;
let hoveredPixel = null;
let roiController;

function updatePixelReadout() {
  const keys = ['signal', 'magnitude', 'noise', 'gray', 'rho', 't1', 't2', 't2star'];
  if (!hoveredPixel || !phantom) {
    elements['pixel-position'].textContent = 'Hover over the image';
    for (const key of keys) elements[`pixel-${key}`].textContent = '—';
    return;
  }
  const { column, row, index } = hoveredPixel;
  const slice = phantom.getSlice(state.slice);
  const pixel = renderer.getPixel(index);
  const values = [signal[index], pixel.magnitude, pixel.noise, pixel.grayscale,
    slice.Rho[index], slice.T1[index], slice.T2[index], slice.T2Star[index]];
  elements['pixel-position'].textContent = `Row ${row} · Column ${column} · Slice ${state.slice}`;
  keys.forEach((key, i) => {
    elements[`pixel-${key}`].textContent = !Number.isFinite(values[i]) ? 'Undefined'
      : key === 'gray' ? String(values[i]) : values[i].toPrecision(6);
  });
}

function hoverPixel(event, leave = false) {
  if (!phantom) return;
  hoveredPixel = leave ? null : pixelAt(event.clientX, event.clientY, elements['mri-image'].getBoundingClientRect(), phantom.width, phantom.height);
  updatePixelReadout();
}
elements['mri-image'].addEventListener('pointermove', hoverPixel);
elements['mri-image'].addEventListener('pointerleave', () => { hoveredPixel = null; updatePixelReadout(); });

// Show selected panels and keep their numbering consistent.
function updateViewOptions() {
  document.documentElement.dataset.theme = state.darkMode ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = state.darkMode ? '#151c1b' : '#f5f4ef';
  elements['dark-mode'].checked = state.darkMode;
  elements['show-equations'].checked = state.showEquations;
  elements['equations-panel'].hidden = !state.showEquations;
  elements.lab.classList.toggle('with-equations', state.showEquations);
  elements['show-diagram'].checked = state.showDiagram;
  elements['diagram-panel'].hidden = !state.showDiagram;
  elements.lab.classList.toggle('with-diagram', state.showDiagram);
  elements.lab.closest('main').classList.toggle('with-diagram', state.showDiagram);
  elements['define-rois'].checked = state.showRois;
  elements['roi-panel'].hidden = !state.showRois;
  elements.lab.classList.toggle('with-rois', state.showRois);
  elements.lab.closest('main').classList.toggle('with-rois', state.showRois);
  elements['equation-number'].textContent = state.showRois ? '04' : '03';
  elements['diagram-number'].textContent = String(3 + Number(state.showEquations) + Number(state.showRois)).padStart(2, '0');
}
// Use dark mode unless the user saved a light-mode preference.
try { state.darkMode = localStorage.getItem('mrilab-dark-mode') !== 'false'; } catch { /* Storage is optional. */ }
elements['dark-mode'].addEventListener('change', () => {
  state.darkMode = elements['dark-mode'].checked;
  updateViewOptions();
  try { localStorage.setItem('mrilab-dark-mode', String(state.darkMode)); } catch { /* Storage is optional. */ }
});
elements['show-equations'].addEventListener('change', () => {
  state.showEquations = elements['show-equations'].checked;
  updateViewOptions();
  updateEquations();
});
elements['show-diagram'].addEventListener('change', () => {
  state.showDiagram = elements['show-diagram'].checked;
  updateViewOptions();
  updateDiagram();
});
elements['define-rois'].addEventListener('change', () => {
  state.showRois = elements['define-rois'].checked;
  if (state.showRois) state.showDiagram = true;
  updateViewOptions();
  roiController.update();
  updateDiagram();
  if (state.showRois && phantom) roiController.start(0);
});
updateViewOptions();
elements['noise-free'].checked = state.noiseFree;
elements['noise-free'].addEventListener('change', () => {
  state.noiseFree = elements['noise-free'].checked;
  updateEquations();
  scheduleRender();
});

function updateRange(input) {
  const progress = 100 * (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty('--progress', `${progress}%`);
}

function formatValue(parameter, value) {
  return `${value.toFixed(3)} ${parameter.unit}`;
}

function updateEquations() {
  const sequence = sequences[state.sequence];
  elements['equation-sequence'].textContent = sequence.label;
  if (!state.showEquations) return;
  renderLatex(elements['signal-equation'], sequence.equation ?? String.raw`\text{Equation not provided.}`);
  renderLatex(elements['display-equation'], state.noiseFree
    ? String.raw`\begin{aligned} M &= \lvert S \rvert \quad (n=0) \\ \mathrm{Gray} &= 255\,\frac{M}{\max(M)} \end{aligned}`
    : String.raw`\begin{aligned} M &= \lvert S + n \rvert \\ \mathrm{Gray} &= 255\,\frac{M}{\max(M)} \end{aligned}`);
}

function updateDiagram() {
  if (!state.showDiagram) return;
  const sequence = sequences[state.sequence];
  elements['diagram-sequence'].textContent = sequence.label;
  elements['diagram-notes'].textContent = renderSequenceDiagram(elements['sequence-diagram'], sequence, state.parameters,
    state.showRois ? roiController?.getPlot() : null).join(' ');
  elements['diagram-signal-description'].textContent = state.showRois
    ? (state.sequence === 'IR' ? 'ROI curves start at inversion (t = 0): longitudinal recovery before TI, transverse decay after excitation. Solid: signed mean + noise. Dotted: mean magnitude. Image sampling occurs at TI + TE.' : 'RF heights indicate flip angle. Gradients and pulse widths are schematic. The enlarged signal track shows ROI mean magnitude; time starts at excitation, and image sampling is marked at TE.')
    : 'RF heights indicate flip angle. Gradient shapes and pulse widths are schematic. The signal is a normalized echo illustration, independent of the image and noise.';
}

function createParameterControls() {
  const sequence = sequences[state.sequence];
  updateEquations();
  elements['sequence-description'].textContent = sequence.description ?? '';
  elements.parameters.replaceChildren();
  for (const parameter of sequence.parameters) {
    const wrapper = document.createElement('div');
    wrapper.className = 'parameter';
    const heading = document.createElement('div');
    heading.className = 'control-heading';
    const label = document.createElement('label');
    label.htmlFor = `parameter-${parameter.key}`;
    label.textContent = parameter.key;
    const name = document.createElement('span');
    name.className = 'parameter-name';
    name.textContent = parameter.label;
    label.append(name);
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.id = label.htmlFor;
    output.htmlFor = input.id;
    Object.assign(input, { min: parameter.min, max: parameter.max, step: parameter.step, value: state.parameters[parameter.key] });
    output.textContent = formatValue(parameter, state.parameters[parameter.key]);
    input.addEventListener('input', () => {
      state.parameters[parameter.key] = Number(input.value);
      output.textContent = formatValue(parameter, state.parameters[parameter.key]);
      updateRange(input);
      scheduleRender();
    });
    const endpoints = document.createElement('div');
    endpoints.className = 'range-endpoints';
    for (const value of [parameter.min, parameter.max]) {
      const span = document.createElement('span');
      span.textContent = `${value} ${parameter.unit}`;
      endpoints.append(span);
    }
    heading.append(label, output);
    wrapper.append(heading, input, endpoints);
    elements.parameters.append(wrapper);
    updateRange(input);
  }
}

function render() {
  if (!phantom) { updateDiagram(); return; }
  const sequence = sequences[state.sequence];
  sequence.simulate(phantom.getSlice(state.slice), state.parameters, signal);
  const { invalid } = renderer.render(signal, state.noiseFree);
  elements['image-sequence'].textContent = sequence.label.toUpperCase();
  elements['image-slice'].textContent = `SLICE ${state.slice}`;
  elements['mri-image'].setAttribute('aria-label', `${sequence.label} MRI image of ${simulationObjects[state.object].label}, slice ${state.slice} of ${phantom.slices - 1}`);
  elements.status.textContent = invalid
    ? 'Signal is undefined at this parameter combination. Adjust TR or flip angle to continue.'
    : `${state.noiseFree ? 'Noise free' : 'Noise regenerated on slice change'} · Zero-based slice indices · Times in seconds`;
  updatePixelReadout();
  roiController?.update(false);
  updateDiagram();
}

// Combine rapid control changes into one frame.
function scheduleRender() {
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => { pendingFrame = null; render(); });
}

function updateSliceControl() {
  elements.slice.value = state.slice;
  elements['slice-value'].textContent = `${state.slice} / ${phantom ? phantom.slices - 1 : '—'}`;
  updateRange(elements.slice);
}

// Keep the slider, noise, and ROI context in sync.
function changeSlice(index) {
  if (!phantom) return;
  const nextSlice = Math.max(0, Math.min(phantom.slices - 1, index));
  if (nextSlice === state.slice) return;
  roiController?.cancelDrawing();
  state.slice = nextSlice;
  renderer.regenerateNoise();
  roiController?.invalidate();
  updateSliceControl();
  scheduleRender();
}

let wheelDelta = 0;
let lastWheelTime = 0;
elements['image-stage'].addEventListener('wheel', event => {
  // Leave browser zoom gestures and horizontal scrolling intact.
  if (!phantom || event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  if (roiController?.isDrawing) return;
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? elements['image-stage'].clientHeight : 1;
  const delta = event.deltaY * scale;
  const now = performance.now();
  if (now - lastWheelTime > 200 || Math.sign(delta) !== Math.sign(wheelDelta)) wheelDelta = 0;
  lastWheelTime = now;
  wheelDelta += delta;
  // Accumulate small trackpad events instead of advancing a slice on every pixel.
  const steps = Math.trunc(wheelDelta / 40);
  if (steps !== 0) {
    wheelDelta -= steps * 40;
    changeSlice(state.slice + steps);
  }
}, { passive: false });
elements['image-stage'].addEventListener('pointerleave', () => { wheelDelta = 0; });

for (const [key, object] of Object.entries(simulationObjects)) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = object.label;
  elements.object.append(option);
}
elements.object.value = state.object;
elements.object.addEventListener('change', () => {
  state.object = elements.object.value;
  initialize();
});

for (const [key, sequence] of Object.entries(sequences)) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = sequence.label;
  elements.sequence.append(option);
}
elements.sequence.value = state.sequence;
elements.sequence.addEventListener('change', () => {
  state.sequence = elements.sequence.value;
  state.parameters = defaultParameters(sequences[state.sequence]);
  createParameterControls();
  scheduleRender();
});
elements.slice.addEventListener('input', () => {
  wheelDelta = 0;
  changeSlice(Number(elements.slice.value));
});
elements.reset.addEventListener('click', () => {
  state.parameters = defaultParameters(sequences[state.sequence]);
  createParameterControls();
  scheduleRender();
});
elements.retry.addEventListener('click', initialize);
roiController = createRoiController({ state, elements, getPhantom: () => phantom, getRenderer: () => renderer,
  onHover: hoverPixel, onPlot: updateDiagram });
createParameterControls();
updateSliceControl();

async function initialize() {
  elements.object.disabled = true;
  elements['simulation-controls'].disabled = true;
  elements['mri-image'].hidden = true;
  elements['image-plane'].hidden = true;
  roiController.cancelDrawing();
  elements.loading.hidden = false;
  phantom = undefined;
  roiController.invalidate();
  roiController.update();
  hoveredPixel = null;
  updatePixelReadout();
  elements.retry.hidden = true;
  elements.loading.classList.remove('error');
  elements['load-message'].textContent = `Loading ${simulationObjects[state.object].label.toLowerCase()}…`;
  try {
    phantom = loadedObjects.get(state.object) ?? await loadPhantom(state.object);
    loadedObjects.set(state.object, phantom);
    state.slice = Math.min(state.slice, phantom.slices - 1);
    signal = new Float32Array(phantom.width * phantom.height);
    renderer = createRenderer(elements['mri-image'], phantom.width, phantom.height);
    roiController.invalidate();
    elements.slice.max = phantom.slices - 1;
    elements['image-object'].textContent = simulationObjects[state.object].label.toUpperCase();
    updateSliceControl();
    render();
    elements.loading.hidden = true;
    elements['mri-image'].hidden = false;
    elements['image-plane'].hidden = false;
    elements['simulation-controls'].disabled = false;
  } catch (error) {
    elements.loading.classList.add('error');
    phantom = undefined;
    elements['load-message'].textContent = 'The simulation object could not be loaded.';
    elements.status.textContent = `${error.message} Serve this folder with a static HTTP server and try again.`;
    elements.retry.hidden = false;
  } finally {
    elements.object.disabled = false;
  }
}
initialize();
