// Check sequence events and shared timeline coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequences, defaultParameters } from '../js/sequences.js';
import { createTimeAxis } from '../js/sequence-diagram.js';

test('SE refocusing occurs at TE/2 and IR timing begins at the inversion pulse', () => {
  const se = sequences.SE.diagram({ TR: 4, TE: 0.02 });
  assert.equal(se.excitation, 0);
  assert.equal(se.echo, 0.02);
  assert.deepEqual(se.rf.map(pulse => [pulse.time, pulse.angle]), [[0, 90], [0.01, 180], [4, 90]]);
  const ir = sequences.IR.diagram({ TR: 5, TE: 0.08, TI: 1.2 });
  assert.equal(ir.excitation, 1.2);
  assert.equal(ir.echo, 1.28);
  assert.deepEqual(ir.rf.map(pulse => pulse.time), [0, 1.2, 1.24, 5]);
  assert.equal(ir.warnings.length, 0);
});

test('GRE uses the selected flip angle and no RF refocusing pulse', () => {
  const gre = sequences.GRE.diagram({ TR: 0.5, TE: 0.02, FA: 30 });
  assert.equal(gre.echo, 0.02);
  assert.deepEqual(gre.rf.map(pulse => [pulse.time, pulse.angle]), [[0, 30], [0.5, 30]]);
});

test('axis preserves event order and finite coordinates at parameter boundaries', () => {
  for (const sequence of Object.values(sequences)) {
    const cases = [defaultParameters(sequence)];
    for (const parameter of sequence.parameters) {
      for (const value of [parameter.min, parameter.max]) cases.push({ ...defaultParameters(sequence), [parameter.key]: value });
    }
    cases.push(Object.fromEntries(sequence.parameters.map(parameter => [parameter.key, parameter.min])));
    for (const parameters of cases) {
      const model = sequence.diagram(parameters);
      const axis = createTimeAxis(model);
      const times = [...new Set([0, model.echo, model.repetition, ...model.rf.map(pulse => pulse.time)])].sort((a, b) => a - b);
      const positions = times.map(time => axis.x(time));
      assert.ok(positions.every(value => Number.isFinite(value) && value >= 110 && value <= 850));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    }
  }
});

test('long delays are marked as compressed and impossible timing is explained', () => {
  const model = sequences.SE.diagram({ TR: 20, TE: 0.005 });
  assert.ok(createTimeAxis(model).segments.some(segment => segment.compressed));
  assert.ok(sequences.SE.diagram({ TR: 0, TE: 0.1 }).warnings.length > 0);
  assert.equal(sequences.IR.diagram({ TR: 0, TE: 0.1, TI: 0 }).warnings.length, 2);
});
