# SoundBase plugin: Rigol DSA815

A [SoundBase](https://soundbase.app) plugin that turns a Rigol DSA815 or
DSA815-TG spectrum analyzer into a live-scan device over the network. Its
sweeps become the trace on the plot, and SoundBase coordinates against them.

Developed and tested against a DSA815-TG running firmware 00.01.19.00.02 over
its LAN port. The rest of the DSA800 family (DSA832, DSA875 and the E
variants) shares the dialect and is accepted by the model check, but has not
been tried.

## How it talks to the analyzer

The DSA815 offers two things on its LAN port: a raw SCPI socket on TCP 5555
and **VXI-11**, the RPC protocol VISA uses behind a
`TCPIP0::<ip>::inst0::INSTR` resource. During development the raw socket
server wedged permanently after a single unanswered query and only a power
cycle brought it back, while VXI-11 kept working throughout, so this plugin
uses VXI-11. `driver/vxi11.js` is a small VXI-11 client in plain Node: it asks
the analyzer's RPC port mapper (TCP 111) where the instrument channel is,
opens a link, and exchanges SCPI over it. No VISA, no native code.

`driver/dsa815.js` is the instrument: the SCPI commands the unit actually
honours, what it clamps and snaps, how long a sweep takes, and how to read a
trace. `adapter.js` maps that onto the SoundBase contract.

## Using it

1. Put the analyzer on the show network and note its address
   (on the unit: **System > I/O Setting > LAN**).
2. In SoundBase, either:
   - list the address under **Settings > Plugins > Rigol DSA815 > Analyzer
     addresses**, and the unit appears in the live-scan device picker when it
     answers, or
   - pick **Rigol DSA815 (LAN)** from the device picker's "add a device"
     option and type the address.
3. Press **Live**.

What SoundBase can set:

| Setting | What the plugin does |
|---|---|
| Start / stop frequency | 0 Hz to 1.5 GHz, minimum span 100 Hz; the analyzer's readback is what is reported |
| RBW | 10 Hz to 1 MHz in 1-3-10 steps; anything else snaps to the nearest step. Leave it on auto and the analyzer couples it to the span (reported under `resolved`) |
| VBW | 1 Hz to 3 MHz in 1-3-10 steps, or coupled to RBW when left alone |
| Reference level | -100 to +20 dBm. Until SoundBase sets one, the plugin uses -20 dBm so the auto attenuator settles at 10 dB; at the Rigol's own default of 0 dBm it parks at 30 dB and the floor rises by 20 dB. At +20 dBm the analyzer refuses the preamp, and the plugin warns |
| Points | Always 601. This firmware has no point-count command; the plugin declares `autoPointCount` so SoundBase hides the control |
| Detector (control) | Positive peak (default), negative peak, sample, normal, RMS average, voltage average |
| Input attenuation (control) | Auto (coupled to ref level) or 0 to 30 dB |
| Preamplifier (control) | On or Off. On by default: without it the noise floor rises by about 20 dB |
| Sweep time rule (control) | Normal, Speed or Accuracy; Accuracy sweeps about three times slower than Normal |

### Sweep time matters

The analyzer answers nothing while it sweeps, and a sweep cannot be aborted.
The plugin reads the analyzer's own sweep-time estimate after every
configuration change, reports it to SoundBase as `resolved.sweepTimeMs` so the
stall watchdog waits, and sizes its own timeouts from it. It raises a warning
when a sweep will take more than 10 s.

Measured on the test unit, trigger-to-trace per sweep over 470 to 617 MHz:

| RBW | Rule | Per sweep |
|---|---|---|
| 100 kHz | Normal | about 0.26 s |
| 30 kHz | Normal | about 0.4 s |
| 30 kHz | Accuracy | about 0.6 s |
| 10 kHz | Normal | about 1.6 s |
| 10 kHz | Accuracy | about 4.5 s |

Full span at 1 kHz RBW or below is a 1500 s sweep. The plugin will warn, but
it cannot make it faster.

### What the plugin changes on the analyzer

On open: single-sweep mode, binary little-endian trace format, dBm, trace 1
in clear-write with averaging off, sweep time coupled to span and RBW, a
-20 dBm reference level until SoundBase sets one, and
**the tracking generator output off** so a DSA815-TG does not radiate into
whatever its input is connected to. Frequency, amplitude and bandwidth
settings stay as they were until SoundBase sets them. On close the analyzer
is put back into continuous sweep.

## Development

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # the contract, through the real shell, against a fake DSA815
npm run manifest    # validate soundbase-plugin.json against the schema
npm run smoke       # boot as a child process and handshake, exactly as the host does
```

`driver/fake-dsa815.js` is a fake DSA815: a VXI-11 server speaking the SCPI
subset the driver uses, with the real unit's quirks (601 points behind a block
header, ladder snapping, a 30 dB attenuator, silence during a sweep, a
tracking generator left on, an error queue). The tests need no hardware.

To run against a real unit by hand:

```sh
npm start
# SB_PLUGIN_READY {"port":54321}
PORT=54321; DEV=net%3A192.168.42.251
curl -s -X POST localhost:$PORT/devices -H 'content-type: application/json' \
  -d '{"id":"net:192.168.42.251","product":"plugin:rigol-dsa815/dsa815","config":{"host":"192.168.42.251"}}'
curl -s -X POST localhost:$PORT/devices/$DEV/configuration -H 'content-type: application/json' \
  -d '{"startHz":470000000,"stopHz":617000000,"rbwHz":100000}'
curl -s -X POST localhost:$PORT/devices/$DEV/sweep/start
curl -s localhost:$PORT/devices/$DEV/trace
```

[docs/running-in-soundbase.md](docs/running-in-soundbase.md) covers the plugin
manager, the device picker and the logs; the rest of `docs/` is the SoundBase
plugin guide this plugin was built from.

## Things found on the bench, not in the programming guide

- `[:SENSe]:SWEep:POINts` is listed in the DSA800 guide but is an undefined
  header on this firmware; traces are 601 points.
- Values between RBW or VBW ladder steps are rounded down by the instrument,
  not to the nearest step. The plugin snaps on a log scale first.
- `:FORMat:BORDer SWAPped`, the default, gives little-endian floats;
  `NORMal` gives big-endian.
- The raw SCPI socket on port 5555 stops answering for good after a query it
  cannot complete. VXI-11 on the same unit is unaffected.
- `QPEak` as a detector is accepted silently and leaves the detector unchanged
  unless the EMI filter is on, so the plugin does not offer it.

## What you are trusting

Installing a plugin means trusting its author. SoundBase runs a plugin as a
separate process for fault isolation, not as a security sandbox: this code
runs with your user's privileges, like a VST or a Companion module. Everything
it does is in this repository: it opens one TCP connection to the analyzer's
address you give it, sends SCPI over VXI-11, and serves traces to SoundBase on
the loopback interface. It reads and writes no files and talks to nothing else.

## Status

Tested on macOS (Apple silicon), so `platforms` lists only `darwin-arm64`.
The code has nothing platform-specific in it; add `darwin-x64` and
`win32-x64` once it has been run there.

## Licence

MIT for this plugin's code. The SoundBase Plugin SDK it builds on is BUSL-1.1
with an Additional Use Grant for SoundBase plugins; see LICENSE.
