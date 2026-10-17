// Contract tests for the DSA815 adapter, driven through the real shell over
// real HTTP, against the fake instrument in driver/fake-dsa815.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { startFakeDSA815 } from '../driver/fake-dsa815.js';
import { POINT_COUNT, RBW_HZ, VBW_HZ, parseTrace, snapToLadder } from '../driver/dsa815.js';
import { PRODUCT, discoverDevices } from '../adapter.js';

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const instrument = await startFakeDSA815();
const HOST = '127.0.0.1';
const DEVICE_ID = `net:${HOST}:${instrument.port}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;

const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const deviceRecord = async () => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === DEVICE_ID);
};

const addDevice = async () => {
  const added = await request('POST', '/devices', {
    id: DEVICE_ID,
    product: PRODUCT,
    config: { host: HOST, port: instrument.port },
  });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added));
};

test.after(async () => {
  await handle.close();
  await instrument.close();
});

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(declared.includes(PRODUCT), `${PRODUCT} not in ${declared}`);
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('the driver snaps RBW and VBW to their ladders on a log scale', () => {
  assert.equal(snapToLadder(12_345), 10_000);
  assert.equal(snapToLadder(60_000), 100_000);
  assert.equal(snapToLadder(1, RBW_HZ), 10);
  assert.equal(snapToLadder(1e9, RBW_HZ), 1_000_000);
  assert.equal(snapToLadder(5_000_000, VBW_HZ), 3_000_000);
});

test('the driver reads a trace with or without the block header, in either format', () => {
  const values = Array.from({ length: POINT_COUNT }, (_, i) => -100 + i / 10);
  const real = Buffer.alloc(POINT_COUNT * 4);
  values.forEach((v, i) => real.writeFloatLE(v, i * 4));
  const framed = Buffer.concat([Buffer.from(`#9${String(real.length).padStart(9, '0')}`), real, Buffer.from('\n')]);
  assert.ok(Math.abs(parseTrace(framed)[7] - values[7]) < 1e-4);
  assert.ok(Math.abs(parseTrace(real)[600] - values[600]) < 1e-4);

  const ascii = Buffer.from(values.map((v) => ` ${v.toExponential(6)}`).join(',') + '\n');
  const framedAscii = Buffer.concat([Buffer.from(`#9${String(ascii.length).padStart(9, '0')}`), ascii]);
  assert.deepEqual(parseTrace(framedAscii).slice(0, 2), values.slice(0, 2));
  assert.throws(() => parseTrace(Buffer.from('1,2,3\n')), /expected 601 points/);
});

test('discovery probes the configured addresses and names a stable device', async () => {
  const devices = await discoverDevices({ addresses: `${HOST}:${instrument.port}` });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, DEVICE_ID);
  assert.equal(devices[0].product, PRODUCT);
  assert.match(devices[0].name, /DSA815/);
  assert.deepEqual(await discoverDevices({ addresses: '127.0.0.1:1' }), []);
  assert.deepEqual(await discoverDevices({}), []);
});

test('a unit that is not a DSA800-family analyzer is not offered', async () => {
  const other = await startFakeDSA815({ identity: 'Keysight Technologies,N9340B,1,1.0' });
  try {
    assert.deepEqual(await discoverDevices({ addresses: `${HOST}:${other.port}` }), []);
  } finally {
    await other.close();
  }
});

test('opening prepares the instrument and reports capabilities from it', async () => {
  await addDevice();
  const configured = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 1001,
    rbwHz: 100_000,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const device = await deviceRecord();
  assert.equal(device.status.status, 'ok');
  const caps = device.capabilities;
  assert.equal(caps.autoPointCount, true);
  assert.deepEqual(caps.rbwHz, RBW_HZ);
  assert.deepEqual(caps.vbwHz, VBW_HZ);
  assert.equal(caps.minRefLevelDbm, -100);
  assert.equal(caps.maxRefLevelDbm, 20);
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['detector', 'attenuation', 'preamp', 'sweepRule']
  );
  // single sweep, binary little-endian traces, and the tracking generator off
  assert.equal(instrument.state.continuous, false);
  assert.equal(instrument.state.format, 'REAL');
  assert.equal(instrument.state.byteOrder, 'SWAP');
  assert.equal(instrument.state.tgOutput, false);
  // the preamp is on by default, and the reference level is -20 dBm so the
  // auto attenuator settles at 10 dB rather than 30
  assert.equal(instrument.state.preamp, true);
  assert.equal(configured.body.controls.preamp, 'on');
  assert.equal(configured.body.resolved.refLevelDbm, -20);
  assert.equal(configured.body.resolved.attenuationDb, 10);
});

test('the echo reports 601 points whatever was asked, and the real sweep time', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 1001,
    rbwHz: 100_000,
  });
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, POINT_COUNT);
  assert.equal(body.rbwHz, 100_000);
  assert.ok(body.resolved.sweepTimeMs > 0);
  assert.equal(body.vbwHz, undefined);
  assert.equal(typeof body.resolved.vbwHz, 'number');
  assert.equal(typeof body.resolved.refLevelDbm, 'number');
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const { status, body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: -5,
    stopHz: 9_000_000_000,
    rbwHz: 12_345,
    vbwHz: 5_000_000,
    refLevelDbm: 99,
  });
  assert.equal(status, 200);
  assert.equal(body.startHz, 0);
  assert.equal(body.stopHz, 1_500_000_000);
  assert.equal(body.rbwHz, 10_000);
  assert.equal(body.resolved.vbwHz, 3_000_000);
  assert.equal(instrument.state.vbwHz, 3_000_000);
  assert.equal(body.resolved.refLevelDbm, 20);
  // at +20 dBm the instrument refuses the preamp; the echo says so and warns
  assert.equal(body.controls.preamp, 'off');
  const device = await deviceRecord();
  assert.ok(
    (device.status.warnings ?? []).some((w) => w.id === 'preamp-refused'),
    JSON.stringify(device.status)
  );
  // lowering the reference level brings it back without being asked again
  const lowered = await request('POST', `${DEVICE_PATH}/configuration`, { refLevelDbm: -20 });
  assert.equal(lowered.body.controls.preamp, 'on');
  assert.ok(!((await deviceRecord()).status.warnings ?? []).some((w) => w.id === 'preamp-refused'));
});

test('omitting RBW means auto, reported under resolved', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: null,
  });
  assert.equal(body.rbwHz, undefined);
  assert.ok(RBW_HZ.includes(body.resolved.rbwHz));
  assert.equal(instrument.state.rbwAuto, true);
});

test('controls are merged by id and echoed as the instrument settled on them', async () => {
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'RMS', sweepRule: 'speed' },
  });
  assert.equal(first.body.controls.detector, 'RMS');
  assert.equal(first.body.controls.sweepRule, 'speed');
  assert.equal(first.body.controls.attenuation, 'auto');

  const second = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { attenuation: '20', preamp: 'off' },
  });
  assert.equal(second.body.controls.attenuation, '20');
  assert.equal(second.body.controls.preamp, 'off');
  assert.equal(second.body.controls.detector, 'RMS', 'untouched control survived');
  assert.equal(instrument.state.attenDb, 20);
  assert.equal(instrument.state.preamp, false);

  // an unsupported detector falls back to positive peak; 42 dB clamps to 30
  const third = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'QPE', attenuation: '42', preamp: null, sweepRule: 'normal' },
  });
  assert.equal(third.body.controls.detector, 'POS');
  assert.equal(third.body.controls.attenuation, '30');
  assert.equal(third.body.controls.preamp, 'on');
  assert.equal(third.body.controls.sweepRule, 'normal');
});

test('sweeping produces traces whose geometry matches the effective config', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 100_000,
    controls: { attenuation: 'auto' },
  });
  const sweepsBefore = instrument.state.sweepCount;
  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, applied.body.startHz);
  assert.equal(trace.body.stopHz, applied.body.stopHz);
  assert.equal(trace.body.unit, 'dBm');
  assert.ok(instrument.state.sweepCount > sweepsBefore);

  const amps = trace.body.amplitudesDbm;
  assert.ok(amps[Math.floor(POINT_COUNT / 2)] > -50, 'carrier in the middle bin');
  assert.ok(amps[10] < -90 && amps[10] > -110, `floor read ${amps[10]}`);

  const next = await request('GET', `${DEVICE_PATH}/trace`);
  assert.ok(next.body.sweepId > trace.body.sweepId);
});

test('a sweep that outlasts its expected time fails the device rather than hanging', async (t) => {
  instrument.state.sweepDelayMs = 7_000;
  t.after(() => {
    instrument.state.sweepDelayMs = 20;
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  const deadline = Date.now() + 12_000;
  let device;
  while (Date.now() < deadline) {
    device = await deviceRecord();
    if (device.status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(device.status.status, 'failed', JSON.stringify(device.status));
  assert.match(device.status.message ?? '', /sweep/i);
});

test('a dead transport fails the device and the next operation reopens it', async (t) => {
  const reopened = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 100_000,
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal((await deviceRecord()).status.status, 'ok');

  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  await request('GET', `${DEVICE_PATH}/trace`);
  instrument.dropConnections();

  const deadline = Date.now() + 5_000;
  let device;
  while (Date.now() < deadline) {
    device = await deviceRecord();
    if (device.status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(device.status.status, 'failed', JSON.stringify(device.status));
  assert.match(device.status.message ?? '', /connection/i);
});

test('closing hands the front panel back in continuous sweep', async () => {
  const again = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(instrument.state.continuous, false);
  const removed = await request('DELETE', DEVICE_PATH);
  assert.ok([200, 204].includes(removed.status), JSON.stringify(removed));
  const deadline = Date.now() + 2_000;
  while (!instrument.state.continuous && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(instrument.state.continuous, true);
});

test('a freshly opened unit with its preamp off gets it switched on by default', async () => {
  instrument.state.preamp = false;
  await addDevice();
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  assert.equal(body.controls.preamp, 'on');
  assert.equal(instrument.state.preamp, true);
});
