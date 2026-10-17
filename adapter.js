// SoundBase adapter for the Rigol DSA815 / DSA815-TG spectrum analyzer.
//
// This file knows the SoundBase contract: what open() must report, how
// applyConfig() echoes, what a trace looks like. driver/dsa815.js knows the
// instrument. Nothing here touches the wire directly.
//
// The DSA815 is addressed by IP; its VXI-11 port comes from the instrument's
// RPC port mapper. Users either list addresses in the plugin settings, so
// discovery finds the units that answer, or add a unit by address from the
// device picker.

import {
  DSA815,
  probe,
  POINT_COUNT,
  MIN_FREQUENCY_HZ,
  MAX_FREQUENCY_HZ,
  RBW_HZ,
  VBW_HZ,
  MIN_REF_LEVEL_DBM,
  MAX_REF_LEVEL_DBM,
  DETECTORS,
  SWEEP_RULES,
} from './driver/dsa815.js';

export const PRODUCT = 'plugin:rigol-dsa815/dsa815';

/** The DSA800 family shares this dialect: DSA815, DSA832, DSA875 and the -TG / E variants. */
const MODEL_PATTERN = /^DSA8\d\d/i;

/** Above this, a live view is not live; tell the user why. */
const SLOW_SWEEP_WARNING_MS = 10_000;

/** Used until SoundBase sets a reference level of its own. */
const DEFAULT_REF_LEVEL_DBM = -20;

/** What the plugin adds on top of the instrument's own sweep time estimate. */
const SWEEP_OVERHEAD_MS = 400;

const ATTENUATION_CHOICES = [
  { id: 'auto', label: 'Auto (coupled to ref level)' },
  ...[0, 5, 10, 15, 20, 25, 30].map((db) => ({ id: String(db), label: `${db} dB` })),
];

const DETECTOR_CHOICES = [
  { id: 'POS', label: 'Positive peak' },
  { id: 'NEG', label: 'Negative peak' },
  { id: 'SAMP', label: 'Sample' },
  { id: 'NORM', label: 'Normal' },
  { id: 'RMS', label: 'RMS average' },
  { id: 'VAV', label: 'Voltage average' },
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export async function discoverDevices(pluginConfig = {}) {
  const addresses = parseAddresses(pluginConfig.addresses);
  const found = await Promise.all(
    addresses.map(async ({ host, port }) => {
      const identity = await probe({ host, port });
      if (!identity || !MODEL_PATTERN.test(identity.model)) return null;
      return {
        id: deviceId(host, port),
        name: `${identity.model} ${identity.serial ?? ''} (${host})`.replace('  ', ' '),
        product: PRODUCT,
        transport: { kind: 'vxi11', host, ...(port ? { port } : {}) },
      };
    })
  );
  return found.filter(Boolean);
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new DSA815Adapter(device, pluginConfig);
}

class DSA815Adapter {
  constructor(device) {
    const { host, port } = addressOf(device);
    this.host = host;
    this.port = port;
    this.instrument = null;
    this.preampRefused = false;
    this.effective = null;
    this.sweepTimeMs = 0;
    this.sweeping = false;
    this.lock = Promise.resolve();
    /** assigned by the shell */
    this.onFatal = null;
    this.onWarnings = null;
  }

  /** Run `fn` with exclusive use of the instrument. */
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async open() {
    const instrument = new DSA815({ host: this.host, port: this.port });
    instrument.onFatal = (err) =>
      this.onFatal?.(
        new Error(
          `Lost the connection to the DSA815 at ${this.host}: ${err?.message ?? 'connection closed'}`
        )
      );
    try {
      await instrument.connect();
    } catch (err) {
      throw new Error(
        `Could not reach a DSA815 at ${this.host}: ${err.message}. ` +
          'Check the address, that the analyzer is on the same network, and that LAN is enabled under System > I/O Setting.'
      );
    }
    const identity = instrument.identity;
    if (!MODEL_PATTERN.test(identity.model ?? '')) {
      await instrument.close();
      throw new Error(
        `${this.host} is a ${identity.manufacturer} ${identity.model}, not a DSA800-family analyzer.`
      );
    }
    this.instrument = instrument;
    await instrument.prepare();

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        rbwHz: [...RBW_HZ],
        vbwHz: [...VBW_HZ],
        minRefLevelDbm: MIN_REF_LEVEL_DBM,
        maxRefLevelDbm: MAX_REF_LEVEL_DBM,
        // the DSA815 always sweeps 601 points; there is no point-count command
        autoPointCount: true,
        controls: [
          {
            id: 'detector',
            type: 'dropdown',
            label: 'Detector',
            default: 'POS',
            choices: DETECTOR_CHOICES,
            help: 'Positive peak is the safe choice for finding occupied channels: it never under-reads a carrier.',
          },
          {
            id: 'attenuation',
            type: 'dropdown',
            label: 'Input attenuation',
            default: 'auto',
            choices: ATTENUATION_CHOICES,
            help: 'Auto couples the attenuator to the reference level. Raise it if strong nearby transmitters are compressing the front end.',
          },
          {
            id: 'preamp',
            type: 'dropdown',
            label: 'Preamplifier',
            default: 'on',
            choices: [
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
            ],
            help: 'Internal preamp. Keep it on for coordination: off, the noise floor rises by about 20 dB. Switch it off only next to strong transmitters.',
          },
          {
            id: 'sweepRule',
            type: 'dropdown',
            label: 'Sweep time rule',
            default: 'normal',
            choices: [
              { id: 'normal', label: 'Normal' },
              { id: 'speed', label: 'Speed' },
              { id: 'accuracy', label: 'Accuracy' },
            ],
            help: 'How the analyzer picks its automatic sweep time. Accuracy sweeps about three times slower than Normal.',
          },
        ],
      },
      identity: {
        manufacturer: identity.manufacturer,
        model: identity.model,
        firmware: identity.firmware,
        serial: identity.serial,
      },
    };
  }

  applyConfig(cfg = {}) {
    return this.exclusive(() => this.#applyConfig(cfg));
  }

  async #applyConfig(cfg) {
    const instrument = this.#requireInstrument();
    const previous = this.effective ?? { controls: {} };
    const effective = {
      pointCount: POINT_COUNT,
      controls: { ...previous.controls },
      resolved: {},
    };

    // -- frequency range
    if (isNum(cfg.startHz) || isNum(cfg.stopHz) || !isNum(previous.startHz)) {
      const current =
        isNum(previous.startHz) && isNum(previous.stopHz)
          ? previous
          : await instrument.getFrequencyRange();
      const range = await instrument.setFrequencyRange(
        isNum(cfg.startHz) ? cfg.startHz : current.startHz,
        isNum(cfg.stopHz) ? cfg.stopHz : current.stopHz
      );
      effective.startHz = range.startHz;
      effective.stopHz = range.stopHz;
    } else {
      effective.startHz = previous.startHz;
      effective.stopHz = previous.stopHz;
    }

    // -- RBW / VBW. The shell hands us its whole desired configuration, not
    // a delta, so a missing value is "the analyzer's choice", reported under
    // `resolved`; a manual value is echoed as the instrument snapped it.
    const rbw = await instrument.setRbw(isNum(cfg.rbwHz) ? cfg.rbwHz : null);
    if (rbw.auto) effective.resolved.rbwHz = rbw.rbwHz;
    else effective.rbwHz = rbw.rbwHz;

    // the shell echoes the requested VBW, so the readback (snapped to the
    // ladder) is always under resolved, manual or not
    const vbw = await instrument.setVbw(isNum(cfg.vbwHz) ? cfg.vbwHz : null);
    effective.resolved.vbwHz = vbw.vbwHz;
    if (!vbw.auto) effective.vbwHz = vbw.vbwHz;

    // -- reference level. The shell reports the requested value, so the
    // instrument's readback (clamped to -100..+20 dBm) goes under `resolved`.
    // Until SoundBase asks for one, use -20 dBm rather than the Rigol's 0 dBm
    // default: at 0 dBm the auto attenuator parks at 30 dB with the preamp on
    // and the noise floor sits near -72 dBm, which looks like a broken plugin.
    const refLevel = isNum(cfg.refLevelDbm)
      ? await instrument.setRefLevel(cfg.refLevelDbm)
      : previous.refLevelDbm === undefined
        ? await instrument.setRefLevel(DEFAULT_REF_LEVEL_DBM)
        : await instrument.getRefLevel();
    effective.refLevelDbm = refLevel;
    effective.resolved.refLevelDbm = refLevel;

    // -- controls
    const controls = cfg.controls ?? {};

    if (controls.detector !== undefined || previous.controls.detector === undefined) {
      const want = String(controls.detector ?? 'POS').toUpperCase();
      effective.controls.detector = await instrument.setDetector(
        DETECTORS.includes(want) ? want : 'POS'
      );
    }

    // preamp before attenuation: auto attenuation re-couples when the preamp
    // changes, so the attenuator is read back last. No explicit choice means
    // on; 'off', false or 'false' mean off.
    // Read back rather than trust what we last set: the instrument switches
    // the preamp off by itself when the reference level goes to +20 dBm.
    const preampWanted = !['off', false, 'false'].includes(controls.preamp);
    let preampOn = await instrument.getPreamp();
    if (preampWanted !== preampOn) preampOn = await instrument.setPreamp(preampWanted);
    effective.controls.preamp = preampOn ? 'on' : 'off';
    this.preampRefused = preampWanted && !preampOn;

    if (controls.attenuation !== undefined || previous.controls.attenuation === undefined) {
      const want = controls.attenuation ?? 'auto';
      const atten = await instrument.setAttenuation(
        want === 'auto' || want === null ? 'auto' : Number(want)
      );
      effective.controls.attenuation = atten.auto ? 'auto' : String(atten.db);
    }
    effective.resolved.attenuationDb = (await instrument.getAttenuation()).db;

    if (controls.sweepRule !== undefined || previous.controls.sweepRule === undefined) {
      const want = SWEEP_RULES.includes(controls.sweepRule) ? controls.sweepRule : 'normal';
      effective.controls.sweepRule = await instrument.setSweepRule(want);
    }

    // -- what this costs per sweep, so the host's stall watchdog can wait
    this.sweepTimeMs = await instrument.getSweepTimeMs();
    effective.resolved.sweepTimeMs = this.sweepTimeMs + SWEEP_OVERHEAD_MS;

    this.effective = effective;
    this.#reportWarnings(await instrument.errors());
    console.log(
      `[net:${this.host}] applied ${(effective.startHz / 1e6).toFixed(3)}-${(effective.stopHz / 1e6).toFixed(3)} MHz ` +
        `rbw=${effective.rbwHz ?? `auto(${effective.resolved.rbwHz})`} ` +
        `vbw=${effective.vbwHz ?? `auto(${effective.resolved.vbwHz})`} ` +
        `ref=${effective.refLevelDbm} dBm det=${effective.controls.detector} ` +
        `atten=${effective.controls.attenuation}(${effective.resolved.attenuationDb} dB) ` +
        `preamp=${effective.controls.preamp} rule=${effective.controls.sweepRule} ` +
        `sweepTime=${this.sweepTimeMs} ms`
    );
    return publicConfig(effective);
  }

  #reportWarnings(errors) {
    const warnings = [];
    if (this.preampRefused) {
      warnings.push({
        id: 'preamp-refused',
        severity: 'warning',
        message:
          `The analyzer refused to switch its preamp on at a reference level of ${this.effective?.refLevelDbm ?? '?'} dBm. ` +
          'Lower the reference level (0 dBm or below works) to get the preamp, and the 15 dB of sensitivity it brings, back.',
      });
    }
    if (this.sweepTimeMs > SLOW_SWEEP_WARNING_MS) {
      warnings.push({
        id: 'slow-sweep',
        severity: 'warning',
        message:
          `One sweep takes ${(this.sweepTimeMs / 1000).toFixed(0)} s at this span and RBW. ` +
          'Widen the RBW, narrow the span, or choose the Speed sweep rule for a live view.',
      });
    }
    for (const e of errors) {
      // -220 is the preamp refusal above, already explained
      if (e.code < 0 && !(e.code === -220 && this.preampRefused)) {
        warnings.push({
          id: `scpi-${Math.abs(e.code)}`,
          severity: 'info',
          message: `The analyzer rejected a command: ${e.message} (${e.code}).`,
        });
      }
    }
    this.onWarnings?.(warnings);
  }

  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    (async () => {
      while (this.sweeping) {
        try {
          const amplitudes = await this.exclusive(() => {
            if (!this.sweeping) return null;
            return this.#requireInstrument().sweep({ sweepTimeMs: this.sweepTimeMs });
          });
          if (this.sweeping && amplitudes) onTrace(amplitudes);
        } catch (err) {
          if (!this.sweeping) return;
          this.sweeping = false;
          this.onFatal?.(
            new Error(
              `The DSA815 at ${this.host} stopped answering during a sweep: ${err.message}`
            )
          );
          return;
        }
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
  }

  /** Release the instrument: continuous sweep back on, link destroyed. */
  async close() {
    this.sweeping = false;
    const instrument = this.instrument;
    this.instrument = null;
    if (!instrument) return;
    await this.exclusive(async () => {
      if (instrument.connected) {
        await instrument.restoreContinuous().catch(() => {});
      }
      await instrument.close();
    });
  }

  #requireInstrument() {
    if (!this.instrument) {
      throw new Error(`the DSA815 at ${this.host} is not open`);
    }
    return this.instrument;
  }
}

function publicConfig(effective) {
  return {
    ...effective,
    controls: { ...effective.controls },
    resolved: { ...effective.resolved },
  };
}

/** "192.168.42.251, 10.0.0.7:618" -> [{ host, port }] (port null = ask the port mapper) */
function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.+?)(?::(\d+))?$/.exec(entry);
      return { host: match[1], port: match[2] ? Number(match[2]) : null };
    });
}

function deviceId(host, port) {
  return port ? `net:${host}:${port}` : `net:${host}`;
}

function addressOf(device) {
  const config = device?.config ?? {};
  if (typeof config.host === 'string' && config.host.trim()) {
    const port = Number(config.port);
    return {
      host: config.host.trim(),
      port: Number.isInteger(port) && port > 0 ? port : null,
    };
  }
  const match = /^net:(.+?)(?::(\d+))?$/.exec(device?.id ?? '');
  if (match) return { host: match[1], port: match[2] ? Number(match[2]) : null };
  throw new Error(
    `device ${device?.id} has no address: set "IP address" in its configuration`
  );
}
