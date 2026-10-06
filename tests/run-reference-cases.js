// Export JavaScript signals for comparison with the Python reference.
import { readFileSync, writeFileSync } from 'node:fs';
import { sequences } from '../js/sequences.js';
import { decodePhantom } from '../js/phantom.js';

const metadata = JSON.parse(readFileSync(new URL('../data/phantom.json', import.meta.url)));
const buffer = readFileSync(new URL('../data/phantom.bin', import.meta.url));
const phantom = decodePhantom(metadata, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
const cases = JSON.parse(readFileSync(process.argv[2]));
const size = phantom.width * phantom.height;
const results = new Float32Array(cases.length * size);
cases.forEach((test, i) => sequences[test.sequence].simulate(phantom.getSlice(test.slice), test.parameters, results.subarray(i * size, (i + 1) * size)));
writeFileSync(process.argv[3], new Uint8Array(results.buffer));
