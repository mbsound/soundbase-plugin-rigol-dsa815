// The Rigol DSA815 (and DSA815-TG) spectrum analyzer, over VXI-11.
//
// This file knows the instrument's SCPI dialect and its quirks; it knows
// nothing about SoundBase. adapter.js translates between the two.
//
// Everything here was checked against a real DSA815-TG (firmware
// 00.01.19.00.02), not just the DSA800 programming guide:
//
//   - The LAN port offers a raw SCPI socket on 5555 and VXI-11. The raw
//     socket server wedged permanently after one unanswered query during
//     testing; VXI-11 never did. This driver uses VXI-11.
//   - A sweep always has 601 points. [:SENSe]:SWEep:POINts, which the guide
//     lists, is an undefined header on this firmware.
//   - RBW is a 1-3-10 ladder from 10 Hz to 1 MHz, VBW from 1 Hz to 3 MHz.
//     Values in between are rounded down by the instrument, so we snap on a
//     log scale first and send exact ladder values.
//   - The attenuator takes 0-30 dB in 1 dB steps and clamps beyond that.
//   - Detectors POS, NEG, SAMP, RMS, VAV and NORM are accepted; QPEak is not
//     (it needs the EMI filter) and leaves the detector unchanged.
//   - `:INIT:IMM;*OPC?` answers when the sweep is done, about 250 ms over
//     the instrument's own sweep time.
//   - Trace data comes as an IEEE 488.2 block (`#9000002404...`) in both
//     formats. REAL,32 is 601 floats; :FORMat:BORDer SWAPped (the default)
//     is little-endian, NORMal is big-endian.
//   - The sweep time at narrow RBW over a wide span goes up to 1500 s. The
//     instrument answers nothing while it sweeps. Know the sweep time before
//     you start.

import { Vxi11Client } from './vxi11.js';

export const POINT_COUNT = 601;
export const MIN_FREQUENCY_HZ = 0;
export const MAX_FREQUENCY_HZ = 1_500_000_000;
export const MIN_SPAN_HZ = 100;
export const RBW_HZ = [10, 30, 100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000];
export const VBW_HZ = [1, 3, 10, 30, 100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000];
export const MIN_REF_LEVEL_DBM = -100;
export const MAX_REF_LEVEL_DBM = 20;
export const MIN_ATTENUATION_DB = 0;
export const MAX_ATTENUATION_DB = 30;
export const DETECTORS = ['POS', 'NEG', 'SAMP', 'RMS', 'VAV', 'NORM'];
export const SWEEP_RULES = ['normal', 'speed', 'accuracy'];

/** Round-trip overhead on top of the instrument's own sweep time. */
const SWEEP_OVERHEAD_MS = 1_500;
const SETTLE_TIMEOUT_MS = 8_000;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Nearest value in a 1-3-10 ladder, compared on a log scale. */
export function snapToLadder(hz, ladder = RBW_HZ) {
  const target = Math.log10(clamp(hz, ladder[0], ladder[ladder.length - 1]));
  return ladder.reduce((best, candidate) =>
    Math.abs(Math.log10(candidate) - target) <
    Math.abs(Math.log10(best) - target)
      ? candidate
      : best
  );
}

const RULE_TO_SCPI = { normal: 'NORM', speed: 'SPE', accuracy: 'ACC' };

export class DSA815 {
  #vxi = null;

  constructor({ host, port = null, connectTimeoutMs, ioTimeoutMs } = {}) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs ?? 3_000;
    this.ioTimeoutMs = ioTimeoutMs ?? 5_000;
    this.identity = null;
    /** set by the owner; called when the transport dies unprompted */
    this.onFatal = null;
  }

  get connected() {
    return !!this.#vxi?.connected;
  }

  // -- connection ------------------------------------------------------------

  async connect() {
    const vxi = new Vxi11Client({
      host: this.host,
      port: this.port,
      connectTimeoutMs: this.connectTimeoutMs,
      ioTimeoutMs: this.ioTimeoutMs,
    });
    vxi.onFatal = (err) => this.onFatal?.(err);
    await vxi.connect();
    this.#vxi = vxi;
    try {
      await vxi.clear();
      this.identity = await this.#identify();
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async #identify() {
    const reply = await this.#query('*IDN?', SETTLE_TIMEOUT_MS);
    const [manufacturer, model, serial, firmware] = reply
      .split(',')
      .map((s) => s.trim());
    if (!model) {
      throw new Error(
        `${this.host} answered *IDN? with "${reply}", which is not an instrument identity`
      );
    }
    return { manufacturer, model, serial, firmware };
  }

  /** Destroy the link. Never throws. */
  async close() {
    const vxi = this.#vxi;
    this.#vxi = null;
    if (vxi) await vxi.close();
  }

  // -- primitives ------------------------------------------------------------

  #require() {
    if (!this.#vxi?.connected) {
      throw new Error(`no connection to the DSA815 at ${this.host}`);
    }
    return this.#vxi;
  }

  async #write(command) {
    await this.#require().write(command);
  }

  async #query(command, timeoutMs = this.ioTimeoutMs) {
    return this.#require().query(command, { timeoutMs });
  }

  async #queryNumber(command) {
    const reply = await this.#query(command);
    const value = Number(reply);
    if (!Number.isFinite(value)) {
      throw new Error(`${command} answered "${reply}", not a number`);
    }
    return value;
  }

  async #queryBool(command) {
    const reply = await this.#query(command);
    return reply === '1' || reply.toUpperCase() === 'ON';
  }

  /** Drain the error queue. Returns [{ code, message }], oldest first. */
  async errors() {
    const out = [];
    for (let i = 0; i < 20; i++) {
      const reply = await this.#query(':SYST:ERR?');
      const match = /^\s*([+-]?\d+)\s*,\s*"?(.*?)"?\s*$/.exec(reply);
      const code = match ? Number(match[1]) : NaN;
      if (!match || code === 0) break;
      out.push({ code, message: match[2] });
    }
    return out;
  }

  // -- instrument state ------------------------------------------------------

  /**
   * Put the instrument into the state the sweep loop relies on. Narrow on
   * purpose: single sweep, binary traces, dBm, trace 1 in clear-write with
   * averaging off, sweep time coupled, and the tracking generator off so a
   * DSA815-TG does not radiate into whatever it is connected to. Frequency,
   * amplitude and bandwidth settings are left alone until asked for.
   */
  async prepare() {
    await this.#write(':INIT:CONT OFF');
    await this.#write(':FORM:TRAC:DATA REAL,32');
    await this.#write(':FORM:BORD SWAP'); // SWAP = little-endian on this unit
    await this.#write(':UNIT:POW DBM');
    await this.#write(':TRAC1:MODE WRIT');
    await this.#write(':SENS:AVER:TRAC1:STAT OFF');
    await this.#write(':SENS:SWE:TIME:AUTO ON');
    await this.#write(':OUTP OFF');
    await this.#write('*CLS');
  }

  /** Hand the front panel back: continuous sweep, as a user expects to find it. */
  async restoreContinuous() {
    await this.#write(':INIT:CONT ON');
  }

  async getFrequencyRange() {
    return {
      startHz: await this.#queryNumber(':SENS:FREQ:STAR?'),
      stopHz: await this.#queryNumber(':SENS:FREQ:STOP?'),
    };
  }

  /** Set start/stop and return what the instrument settled on. */
  async setFrequencyRange(startHz, stopHz) {
    let start = clamp(Math.round(startHz), MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ);
    let stop = clamp(Math.round(stopHz), MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ);
    if (stop - start < MIN_SPAN_HZ) {
      stop = Math.min(MAX_FREQUENCY_HZ, start + MIN_SPAN_HZ);
      start = stop - MIN_SPAN_HZ;
    }
    if (stop > (await this.#queryNumber(':SENS:FREQ:STOP?'))) {
      await this.#write(`:SENS:FREQ:STOP ${stop}`);
      await this.#write(`:SENS:FREQ:STAR ${start}`);
    } else {
      await this.#write(`:SENS:FREQ:STAR ${start}`);
      await this.#write(`:SENS:FREQ:STOP ${stop}`);
    }
    return this.getFrequencyRange();
  }

  /** `null` couples RBW to span. Returns { rbwHz, auto }. */
  async setRbw(hz) {
    if (hz === null || hz === undefined) {
      await this.#write(':SENS:BAND:RES:AUTO ON');
    } else {
      await this.#write(':SENS:BAND:RES:AUTO OFF');
      await this.#write(`:SENS:BAND:RES ${snapToLadder(hz, RBW_HZ)}`);
    }
    return {
      rbwHz: await this.#queryNumber(':SENS:BAND:RES?'),
      auto: await this.#queryBool(':SENS:BAND:RES:AUTO?'),
    };
  }

  /** `null` couples VBW to RBW. Returns { vbwHz, auto }. */
  async setVbw(hz) {
    if (hz === null || hz === undefined) {
      await this.#write(':SENS:BAND:VID:AUTO ON');
    } else {
      await this.#write(':SENS:BAND:VID:AUTO OFF');
      await this.#write(`:SENS:BAND:VID ${snapToLadder(hz, VBW_HZ)}`);
    }
    return {
      vbwHz: await this.#queryNumber(':SENS:BAND:VID?'),
      auto: await this.#queryBool(':SENS:BAND:VID:AUTO?'),
    };
  }

  async setRefLevel(dbm) {
    const value = clamp(Number(dbm), MIN_REF_LEVEL_DBM, MAX_REF_LEVEL_DBM);
    await this.#write(`:DISP:WIN:TRAC:Y:SCAL:RLEV ${value.toFixed(2)}`);
    return this.getRefLevel();
  }

  async getRefLevel() {
    return this.#queryNumber(':DISP:WIN:TRAC:Y:SCAL:RLEV?');
  }

  /** `'auto'` couples attenuation to the reference level. Returns { db, auto }. */
  async setAttenuation(value) {
    if (value === 'auto' || value === null || value === undefined) {
      await this.#write(':SENS:POW:RF:ATT:AUTO ON');
    } else {
      const db = clamp(
        Math.round(Number(value)),
        MIN_ATTENUATION_DB,
        MAX_ATTENUATION_DB
      );
      await this.#write(':SENS:POW:RF:ATT:AUTO OFF');
      await this.#write(`:SENS:POW:RF:ATT ${db}`);
    }
    return this.getAttenuation();
  }

  async getAttenuation() {
    return {
      db: await this.#queryNumber(':SENS:POW:RF:ATT?'),
      auto: await this.#queryBool(':SENS:POW:RF:ATT:AUTO?'),
    };
  }

  async getPreamp() {
    return this.#queryBool(':SENS:POW:RF:GAIN:STAT?');
  }

  async setPreamp(on) {
    await this.#write(`:SENS:POW:RF:GAIN:STAT ${on ? 'ON' : 'OFF'}`);
    return this.getPreamp();
  }

  /** One of DETECTORS. Returns the detector the instrument reports. */
  async setDetector(name) {
    const want = DETECTORS.includes(name) ? name : 'POS';
    await this.#write(`:SENS:DET ${want}`);
    return this.getDetector();
  }

  async getDetector() {
    return (await this.#query(':SENS:DET?')).toUpperCase();
  }

  /** 'normal' | 'speed' | 'accuracy': how the auto sweep time is chosen. */
  async setSweepRule(rule) {
    await this.#write(`:SENS:SWE:TIME:AUTO:RUL ${RULE_TO_SCPI[rule] ?? 'NORM'}`);
    return this.getSweepRule();
  }

  async getSweepRule() {
    const reply = (await this.#query(':SENS:SWE:TIME:AUTO:RUL?')).toUpperCase();
    if (reply.startsWith('SPE')) return 'speed';
    if (reply.startsWith('ACC')) return 'accuracy';
    return 'normal';
  }

  /** The instrument's own estimate of one sweep, in milliseconds. */
  async getSweepTimeMs() {
    const seconds = await this.#queryNumber(':SENS:SWE:TIME?');
    return Math.max(1, Math.round(seconds * 1000));
  }

  // -- sweeping --------------------------------------------------------------

  /** One complete single sweep: trigger, wait for completion, read trace 1. */
  async sweep({ sweepTimeMs = 0 } = {}) {
    const timeoutMs = Math.max(
      this.ioTimeoutMs,
      Math.round(sweepTimeMs * 1.5) + SWEEP_OVERHEAD_MS
    );
    const done = await this.#query(':INIT:IMM;*OPC?', timeoutMs);
    if (done !== '1') {
      throw new Error(`the DSA815 answered "${done}" instead of 1 to *OPC?`);
    }
    return this.readTrace();
  }

  /** Read trace 1 as 601 dBm values, whichever format the instrument is in. */
  async readTrace() {
    const vxi = this.#require();
    await vxi.write(':TRAC:DATA? TRACE1');
    const buf = await vxi.read({ timeoutMs: this.ioTimeoutMs });
    return parseTrace(buf);
  }
}

/**
 * A trace in either format, with or without the `#<n><len>` block header.
 * REAL,32 is 601 little-endian float32; ASCii is ` -7.742305e+01, ...`.
 */
export function parseTrace(buf) {
  let payload = buf;
  if (buf.length >= 2 && buf[0] === 0x23 /* '#' */) {
    const digits = buf[1] - 0x30;
    if (digits >= 1 && digits <= 9 && buf.length >= 2 + digits) {
      const length = Number(buf.subarray(2, 2 + digits).toString('latin1'));
      const start = 2 + digits;
      if (Number.isFinite(length) && buf.length >= start + length) {
        payload = buf.subarray(start, start + length);
      }
    }
  }
  if (payload.length === POINT_COUNT * 4) {
    const out = new Array(POINT_COUNT);
    for (let i = 0; i < POINT_COUNT; i++) out[i] = payload.readFloatLE(i * 4);
    return out;
  }
  const values = payload.toString('latin1').trim().split(',').map(Number);
  if (values.length !== POINT_COUNT || values.some((v) => !Number.isFinite(v))) {
    throw new Error(
      `trace data was ${buf.length} bytes / ${values.length} values, expected ${POINT_COUNT} points`
    );
  }
  return values;
}

/**
 * Is there a DSA815 at this address? For discovery: quick, quiet, never
 * throws. Returns the identity or null.
 */
export async function probe({ host, port = null, timeoutMs = 2_000 }) {
  const instrument = new DSA815({
    host,
    port,
    connectTimeoutMs: timeoutMs,
    ioTimeoutMs: timeoutMs,
  });
  try {
    await instrument.connect();
    return instrument.identity;
  } catch {
    return null;
  } finally {
    await instrument.close();
  }
}
