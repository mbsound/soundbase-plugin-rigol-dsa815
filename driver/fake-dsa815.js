// A fake DSA815: a VXI-11 core-channel server speaking the SCPI subset the
// driver uses, so the tests run with nothing on the bench.
//
// It mimics the real unit's habits where they matter to the adapter: 601
// points behind a `#9` block header, RBW/VBW snapping to the ladders, an
// attenuator that clamps at 30 dB, a sweep time coupled to span, RBW and the
// sweep rule, an instrument that answers nothing while it sweeps, a reply
// that never comes for a command it does not know, and an error queue.
//
// There is no port mapper here (binding port 111 needs root), so tests hand
// the core port straight to the driver.

import net from 'node:net';
import { POINT_COUNT, RBW_HZ, VBW_HZ, snapToLadder } from './dsa815.js';

const DEVICE_CORE_PROG = 395183;
const CREATE_LINK = 10;
const DEVICE_WRITE = 11;
const DEVICE_READ = 12;
const DEVICE_CLEAR = 15;
const DESTROY_LINK = 23;
const REASON_END = 4;
const ERR_IO_TIMEOUT = 15;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export async function startFakeDSA815({
  port = 0,
  sweepDelayMs = 20,
  identity = 'Rigol Technologies,DSA815,DSA8A000000000,00.01.19.00.02',
} = {}) {
  const state = {
    identity,
    continuous: true,
    startHz: 0,
    stopHz: 1_500_000_000,
    rbwHz: 1_000_000,
    rbwAuto: true,
    vbwHz: 1_000_000,
    vbwAuto: true,
    refLevelDbm: 0,
    attenDb: 10,
    attenAuto: true,
    preamp: false,
    detector: 'POS',
    sweepRule: 'NORM',
    sweepTimeAuto: true,
    format: 'ASC',
    byteOrder: 'SWAP',
    traceMode: 'WRIT',
    tgOutput: true, // a DSA815-TG left radiating, which prepare() must stop
    sweepDelayMs,
    sweepCount: 0,
    busyUntil: 0,
    errors: [],
    io: { input: '', output: [] },
    /** amplitudes for the next trace; replace to shape the spectrum */
    trace: (i) =>
      -100 + Math.sin(i / 7) * 2 + (i === Math.floor(POINT_COUNT / 2) ? 60 : 0),
    commandLog: [],
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const session = state.io;
    let buffered = Buffer.alloc(0);
    let fragments = [];
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 4) return;
        const header = buffered.readUInt32BE(0);
        const length = header & 0x7fffffff;
        if (buffered.length < 4 + length) return;
        fragments.push(buffered.subarray(4, 4 + length));
        buffered = buffered.subarray(4 + length);
        if (header & 0x80000000) {
          const message = Buffer.concat(fragments);
          fragments = [];
          handleCall(message, session, state, socket).catch(() => {});
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- RPC plumbing -----------------------------------------------------------

function readCall(message) {
  let o = 0;
  const u32 = () => {
    const v = message.readUInt32BE(o);
    o += 4;
    return v;
  };
  const opaque = () => {
    const len = u32();
    const v = message.subarray(o, o + len);
    o += len + ((4 - (len % 4)) % 4);
    return v;
  };
  const xid = u32();
  const msgType = u32();
  u32(); // rpc version
  const program = u32();
  u32(); // program version
  const procedure = u32();
  u32();
  opaque(); // cred
  u32();
  opaque(); // verf
  return {
    xid,
    msgType,
    program,
    procedure,
    u32,
    opaque,
    i32: () => {
      const v = message.readInt32BE(o);
      o += 4;
      return v;
    },
  };
}

function reply(socket, xid, acceptStat, results = Buffer.alloc(0)) {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(xid, 0);
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(0, 12);
  head.writeUInt32BE(0, 16);
  head.writeUInt32BE(acceptStat, 20);
  const body = Buffer.concat([head, results]);
  const marker = Buffer.alloc(4);
  marker.writeUInt32BE((0x80000000 | body.length) >>> 0, 0);
  if (!socket.destroyed) socket.write(Buffer.concat([marker, body]));
}

const ints = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeInt32BE(v | 0, i * 4));
  return b;
};

const opaque = (buf) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  const pad = Buffer.alloc((4 - (buf.length % 4)) % 4);
  return Buffer.concat([len, buf, pad]);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleCall(message, session, state, socket) {
  const call = readCall(message);
  if (call.msgType !== 0 || call.program !== DEVICE_CORE_PROG) {
    reply(socket, call.xid, 1);
    return;
  }
  switch (call.procedure) {
    case CREATE_LINK: {
      reply(socket, call.xid, 0, ints(0, 1, 0, 4096));
      return;
    }
    case DEVICE_WRITE: {
      call.i32();
      const ioTimeout = call.u32();
      call.u32();
      call.u32();
      const data = call.opaque();
      await waitUntilIdle(state, ioTimeout);
      session.input += data.toString('latin1');
      let index;
      while ((index = session.input.indexOf('\n')) >= 0) {
        const line = session.input.slice(0, index);
        session.input = session.input.slice(index + 1);
        const replies = [];
        for (const command of line.split(';')) {
          const out = execute(command.trim(), state);
          if (out !== undefined) replies.push(out);
        }
        if (replies.length) session.output.push(`${replies.join(';')}\n`);
      }
      reply(socket, call.xid, 0, ints(0, data.length));
      return;
    }
    case DEVICE_READ: {
      call.i32();
      const requestSize = call.u32();
      const ioTimeout = call.u32();
      const deadline = Date.now() + ioTimeout;
      const idle = await waitUntilIdle(state, ioTimeout);
      while (idle && !session.output.length && Date.now() < deadline) {
        if (socket.destroyed) return;
        await sleep(5);
      }
      if (socket.destroyed) return;
      if (!idle || !session.output.length) {
        state.errors.push('-410,"Query INTERRUPTED"');
        reply(socket, call.xid, 0, ints(ERR_IO_TIMEOUT, 0, 0));
        return;
      }
      const pending = Buffer.from(session.output[0], 'latin1');
      const chunk = pending.subarray(0, requestSize);
      if (chunk.length === pending.length) session.output.shift();
      else session.output[0] = pending.subarray(chunk.length).toString('latin1');
      const reason = chunk.length === pending.length ? REASON_END : 0;
      reply(socket, call.xid, 0, Buffer.concat([ints(0, reason), opaque(chunk)]));
      return;
    }
    case DEVICE_CLEAR: {
      session.input = '';
      session.output = [];
      reply(socket, call.xid, 0, ints(0));
      return;
    }
    case DESTROY_LINK: {
      reply(socket, call.xid, 0, ints(0));
      return;
    }
    default:
      reply(socket, call.xid, 3);
  }
}

async function waitUntilIdle(state, ioTimeout) {
  const remaining = state.busyUntil - Date.now();
  if (remaining <= 0) return true;
  await sleep(Math.min(remaining, ioTimeout));
  return state.busyUntil <= Date.now();
}

// --- SCPI -------------------------------------------------------------------

/** Mimics the real unit: 147 MHz at 100 kHz is 15 ms, at 10 kHz 1.47 s. */
function sweepTimeSeconds(state) {
  const span = Math.max(1, state.stopHz - state.startHz);
  const normal = clamp((span / state.rbwHz ** 2) * 1e-5, 0.01, 1500);
  return state.sweepRule === 'ACC' ? normal * 3 : normal;
}

const sci = (n) => n.toExponential(6).replace(/e([+-])(\d)$/, 'E$10$2').replace('e', 'E');

function number(arg) {
  const m = /^\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)\s*$/.exec(arg ?? '');
  if (!m) return NaN;
  const scale = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9, DBM: 1, DB: 1 }[m[2].toUpperCase()];
  return Number(m[1]) * (scale ?? 1);
}

const onOff = (arg) => /^(1|ON)$/i.test((arg ?? '').trim());

/** As observed: auto attenuation is 30 dB at 0 dBm and above, 10 dB below. */
function coupleAttenuation(state) {
  if (state.attenAuto) state.attenDb = state.refLevelDbm >= 0 ? 30 : 10;
}

/** The instrument rounds a value between ladder steps down to the step below. */
function floorToLadder(hz, ladder) {
  const v = clamp(hz, ladder[0], ladder[ladder.length - 1]);
  return ladder.reduce((best, c) => (c <= v ? c : best), ladder[0]);
}

function execute(raw, state) {
  if (!raw) return undefined;
  state.commandLog.push(raw);
  const space = raw.search(/\s/);
  const head = (space < 0 ? raw : raw.slice(0, space)).toUpperCase().replace(/^:/, '');
  const arg = space < 0 ? '' : raw.slice(space + 1).trim();
  const isQuery = head.endsWith('?');
  const key = isQuery ? head.slice(0, -1) : head;

  switch (key) {
    case '*IDN':
      return state.identity;
    case '*CLS':
      state.errors = [];
      return undefined;
    case '*OPC':
      return isQuery ? '1' : undefined;
    case 'SYST:ERR':
      return state.errors.shift() ?? '0,"No error"';
    case 'INIT:CONT':
      if (isQuery) return state.continuous ? '1' : '0';
      state.continuous = onOff(arg);
      return undefined;
    case 'INIT:IMM':
      state.sweepCount += 1;
      state.busyUntil = Date.now() + state.sweepDelayMs;
      return undefined;
    case 'SENS:FREQ:STAR':
      if (isQuery) return String(state.startHz);
      state.startHz = clamp(number(arg), 0, 1.5e9);
      if (state.stopHz - state.startHz < 100) state.stopHz = state.startHz + 100;
      return undefined;
    case 'SENS:FREQ:STOP':
      if (isQuery) return String(state.stopHz);
      state.stopHz = clamp(number(arg), 0, 1.5e9);
      if (state.stopHz - state.startHz < 100) state.startHz = Math.max(0, state.stopHz - 100);
      return undefined;
    case 'SENS:BAND:RES':
      if (isQuery) return String(state.rbwHz);
      state.rbwHz = floorToLadder(number(arg), RBW_HZ);
      state.rbwAuto = false;
      return undefined;
    case 'SENS:BAND:RES:AUTO':
      if (isQuery) return state.rbwAuto ? '1' : '0';
      state.rbwAuto = onOff(arg);
      if (state.rbwAuto) state.rbwHz = snapToLadder((state.stopHz - state.startHz) / 150, RBW_HZ);
      return undefined;
    case 'SENS:BAND:VID':
      if (isQuery) return String(state.vbwHz);
      state.vbwHz = floorToLadder(number(arg), VBW_HZ);
      state.vbwAuto = false;
      return undefined;
    case 'SENS:BAND:VID:AUTO':
      if (isQuery) return state.vbwAuto ? '1' : '0';
      state.vbwAuto = onOff(arg);
      if (state.vbwAuto) state.vbwHz = state.rbwHz;
      return undefined;
    case 'DISP:WIN:TRAC:Y:SCAL:RLEV':
      if (isQuery) return sci(state.refLevelDbm);
      state.refLevelDbm = clamp(number(arg), -100, 20);
      if (state.refLevelDbm >= 20) state.preamp = false; // as the real unit does
      coupleAttenuation(state);
      return undefined;
    case 'UNIT:POW':
    case 'TRAC1:MODE':
    case 'SENS:AVER:TRAC1:STAT':
    case 'SENS:SWE:TIME:AUTO':
      return isQuery ? '1' : undefined;
    case 'OUTP':
    case 'OUTP:STAT':
      if (isQuery) return state.tgOutput ? '1' : '0';
      state.tgOutput = onOff(arg);
      return undefined;
    case 'SENS:POW:RF:ATT':
      if (isQuery) return String(state.attenDb);
      state.attenDb = clamp(Math.round(number(arg)), 0, 30);
      state.attenAuto = false;
      return undefined;
    case 'SENS:POW:RF:ATT:AUTO':
      if (isQuery) return state.attenAuto ? '1' : '0';
      state.attenAuto = onOff(arg);
      coupleAttenuation(state);
      return undefined;
    case 'SENS:POW:RF:GAIN:STAT':
      if (isQuery) return state.preamp ? '1' : '0';
      // the real unit refuses the preamp at a +20 dBm reference level
      if (onOff(arg) && state.refLevelDbm >= 20) {
        state.errors.push('-220,"Parameter error"');
        return undefined;
      }
      state.preamp = onOff(arg);
      coupleAttenuation(state);
      return undefined;
    case 'SENS:DET':
    case 'SENS:DET:FUNC': {
      if (isQuery) return state.detector;
      const want = arg.toUpperCase();
      if (['POS', 'NEG', 'SAMP', 'RMS', 'VAV', 'NORM'].includes(want)) state.detector = want;
      return undefined;
    }
    case 'SENS:SWE:TIME:AUTO:RUL':
      if (isQuery) return state.sweepRule;
      state.sweepRule = arg.toUpperCase().startsWith('SPE') ? 'SPE' : arg.toUpperCase().startsWith('ACC') ? 'ACC' : 'NORM';
      return undefined;
    case 'SENS:SWE:TIME':
      if (isQuery) return sci(sweepTimeSeconds(state));
      return undefined;
    case 'FORM:TRAC:DATA':
      if (isQuery) return state.format === 'REAL' ? 'REAL,32' : 'ASCII';
      state.format = arg.toUpperCase().startsWith('REAL') ? 'REAL' : 'ASC';
      return undefined;
    case 'FORM:BORD':
      if (isQuery) return state.byteOrder;
      state.byteOrder = arg.toUpperCase().startsWith('SWAP') ? 'SWAP' : 'NORM';
      return undefined;
    case 'TRAC:DATA':
    case 'TRAC': {
      if (!isQuery) return undefined;
      const values = Array.from({ length: POINT_COUNT }, (_, i) => state.trace(i));
      let payload;
      if (state.format === 'REAL') {
        payload = Buffer.alloc(POINT_COUNT * 4);
        values.forEach((v, i) =>
          state.byteOrder === 'SWAP' ? payload.writeFloatLE(v, i * 4) : payload.writeFloatBE(v, i * 4)
        );
      } else {
        payload = Buffer.from(values.map((v) => ` ${v.toExponential(6)}`).join(','), 'latin1');
      }
      return `#9${String(payload.length).padStart(9, '0')}${payload.toString('latin1')}`;
    }
    default:
      state.errors.push('-113,"Undefined header; keyword cannot be found"');
      return undefined;
  }
}
