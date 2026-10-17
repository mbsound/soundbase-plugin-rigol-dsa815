// A minimal VXI-11 client over TCP, in plain Node.
//
// The N9340B's LAN interface does not offer a raw SCPI socket (port 5025);
// it only speaks VXI-11, the ONC-RPC based protocol that VISA uses behind a
// `TCPIP0::<host>::inst0::INSTR` resource string. This file is just enough of
// VXI-11 to drive a SCPI instrument: ask the portmapper where the core channel
// is, create a link, write a command, read the reply, destroy the link.
//
// Nothing here knows about spectrum analyzers or SoundBase. It is the wire,
// and only the wire.
//
// References: RFC 1057 (ONC RPC v2), RFC 1831/1832 (XDR), RFC 1833
// (portmapper), VXI-11 specification revision 1.0 (VXIbus Consortium).

import net from 'node:net';

const PORTMAP_PORT = 111;
const PORTMAP_PROG = 100000;
const PORTMAP_VERS = 2;
const PORTMAP_GETPORT = 3;
const IPPROTO_TCP = 6;

export const DEVICE_CORE_PROG = 395183;
export const DEVICE_CORE_VERS = 1;
const CREATE_LINK = 10;
const DEVICE_WRITE = 11;
const DEVICE_READ = 12;
const DEVICE_CLEAR = 15;
const DESTROY_LINK = 23;

const RPC_CALL = 0;
const RPC_REPLY = 1;
const RPC_VERSION = 2;

// device_read "reason" bits
const REASON_REQCNT = 1; // the requested byte count was reached
const REASON_CHR = 2; // the termination character was seen
const REASON_END = 4; // the device asserted END (EOI)

// device_flags
const FLAG_END = 8; // this write is the end of a message

export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_IO_TIMEOUT_MS = 5_000;

/** VXI-11 error codes, for messages a human can act on. */
const VXI_ERRORS = {
  0: 'no error',
  1: 'syntax error',
  3: 'device not accessible',
  4: 'invalid link identifier',
  5: 'parameter error',
  6: 'channel not established',
  8: 'operation not supported',
  9: 'out of resources',
  11: 'device locked by another link',
  12: 'no lock held by this link',
  15: 'I/O timeout',
  17: 'I/O error',
  21: 'invalid address',
  23: 'abort',
  29: 'channel already established',
};

export class Vxi11Error extends Error {
  constructor(code, operation) {
    super(
      `VXI-11 ${operation} failed: ${VXI_ERRORS[code] ?? `error ${code}`} (${code})`
    );
    this.code = code;
    this.operation = operation;
  }
}

// --- XDR -------------------------------------------------------------------

class XdrWriter {
  #chunks = [];
  u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    this.#chunks.push(b);
    return this;
  }
  i32(n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n | 0, 0);
    this.#chunks.push(b);
    return this;
  }
  bool(v) {
    return this.u32(v ? 1 : 0);
  }
  opaque(buf) {
    this.u32(buf.length);
    this.#chunks.push(buf);
    const pad = (4 - (buf.length % 4)) % 4;
    if (pad) this.#chunks.push(Buffer.alloc(pad));
    return this;
  }
  string(s) {
    return this.opaque(Buffer.from(s, 'latin1'));
  }
  toBuffer() {
    return Buffer.concat(this.#chunks);
  }
}

class XdrReader {
  #offset = 0;
  constructor(buf) {
    this.buf = buf;
  }
  u32() {
    const v = this.buf.readUInt32BE(this.#offset);
    this.#offset += 4;
    return v;
  }
  i32() {
    const v = this.buf.readInt32BE(this.#offset);
    this.#offset += 4;
    return v;
  }
  opaque() {
    const len = this.u32();
    const v = this.buf.subarray(this.#offset, this.#offset + len);
    this.#offset += len + ((4 - (len % 4)) % 4);
    return v;
  }
  /** skip an opaque_auth: flavor + body */
  auth() {
    this.u32();
    this.opaque();
  }
}

// --- ONC RPC over TCP ------------------------------------------------------

/**
 * One TCP connection to one RPC program. Calls are sequential: VXI-11 core
 * channel servers answer in order, and an instrument is not a place to pipeline
 * anyway.
 */
class RpcClient {
  #socket = null;
  #buffered = Buffer.alloc(0);
  #fragments = [];
  #pending = new Map(); // xid -> { resolve, reject, timer }
  #xid = (Math.random() * 0x7fffffff) >>> 0;

  constructor({ host, port, program, version, connectTimeoutMs }) {
    this.host = host;
    this.port = port;
    this.program = program;
    this.version = version;
    this.connectTimeoutMs = connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    /** called when the socket dies without a close() having been asked for */
    this.onClose = null;
  }

  get connected() {
    return !!this.#socket && !this.#socket.destroyed;
  }

  async connect() {
    this.#socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `${this.host}:${this.port} did not accept a connection in ${this.connectTimeoutMs / 1000}s`
          )
        );
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.#socket.on('data', (chunk) => this.#consume(chunk));
    const die = (err) => {
      const reason =
        err ?? new Error(`connection to ${this.host}:${this.port} closed`);
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(reason);
      }
      this.#pending.clear();
      this.onClose?.(reason);
    };
    this.#socket.on('error', die);
    this.#socket.on('close', () => die(null));
  }

  /** RFC 1057 record marking: 4-byte header, high bit = last fragment. */
  #consume(chunk) {
    this.#buffered = Buffer.concat([this.#buffered, chunk]);
    for (;;) {
      if (this.#buffered.length < 4) return;
      const header = this.#buffered.readUInt32BE(0);
      const last = (header & 0x80000000) !== 0;
      const length = header & 0x7fffffff;
      if (this.#buffered.length < 4 + length) return;
      this.#fragments.push(this.#buffered.subarray(4, 4 + length));
      this.#buffered = this.#buffered.subarray(4 + length);
      if (last) {
        const message = Buffer.concat(this.#fragments);
        this.#fragments = [];
        this.#dispatch(message);
      }
    }
  }

  #dispatch(message) {
    let xid;
    try {
      const r = new XdrReader(message);
      xid = r.u32();
      const waiter = this.#pending.get(xid);
      if (!waiter) return; // a reply to a call we gave up on
      this.#pending.delete(xid);
      clearTimeout(waiter.timer);
      const msgType = r.u32();
      if (msgType !== RPC_REPLY) {
        waiter.reject(new Error(`RPC message ${xid} is not a reply`));
        return;
      }
      const replyStat = r.u32();
      if (replyStat !== 0) {
        waiter.reject(new Error(`RPC call ${xid} was denied (${replyStat})`));
        return;
      }
      r.auth();
      const acceptStat = r.u32();
      if (acceptStat !== 0) {
        const names = {
          1: 'program unavailable',
          2: 'program version mismatch',
          3: 'procedure unavailable',
          4: 'garbage arguments',
          5: 'system error',
        };
        waiter.reject(
          new Error(
            `RPC program ${this.program} rejected the call: ${names[acceptStat] ?? acceptStat}`
          )
        );
        return;
      }
      waiter.resolve(r);
    } catch (err) {
      const waiter = xid !== undefined ? this.#pending.get(xid) : null;
      if (waiter) {
        this.#pending.delete(xid);
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    }
  }

  /**
   * Send one call and resolve with an XdrReader positioned at the results.
   * `timeoutMs` is how long we wait for any reply at all; the instrument's own
   * I/O timeout travels inside the VXI-11 arguments.
   */
  call(procedure, args, timeoutMs) {
    if (!this.connected) {
      return Promise.reject(
        new Error(`not connected to ${this.host}:${this.port}`)
      );
    }
    const xid = (this.#xid = (this.#xid + 1) >>> 0);
    const body = new XdrWriter()
      .u32(xid)
      .u32(RPC_CALL)
      .u32(RPC_VERSION)
      .u32(this.program)
      .u32(this.version)
      .u32(procedure)
      .u32(0) // cred: AUTH_NULL
      .u32(0)
      .u32(0) // verf: AUTH_NULL
      .u32(0)
      .toBuffer();
    const payload = Buffer.concat([body, args]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE((0x80000000 | payload.length) >>> 0, 0);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(xid);
        reject(
          new Error(
            `${this.host}:${this.port} did not answer RPC procedure ${procedure} within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.#pending.set(xid, { resolve, reject, timer });
      this.#socket.write(Buffer.concat([header, payload]));
    });
  }

  close() {
    this.onClose = null;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('connection closed'));
    }
    this.#pending.clear();
    this.#socket?.destroy();
    this.#socket = null;
  }
}

// --- portmapper ------------------------------------------------------------

/**
 * Ask the instrument's portmapper which TCP port its VXI-11 core channel is on.
 * Returns 0 when the program is not registered — i.e. this host is not a
 * VXI-11 instrument.
 */
export async function getCorePort(
  host,
  { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}
) {
  const rpc = new RpcClient({
    host,
    port: PORTMAP_PORT,
    program: PORTMAP_PROG,
    version: PORTMAP_VERS,
    connectTimeoutMs: timeoutMs,
  });
  try {
    await rpc.connect();
    const args = new XdrWriter()
      .u32(DEVICE_CORE_PROG)
      .u32(DEVICE_CORE_VERS)
      .u32(IPPROTO_TCP)
      .u32(0)
      .toBuffer();
    const reply = await rpc.call(PORTMAP_GETPORT, args, timeoutMs);
    return reply.u32();
  } finally {
    rpc.close();
  }
}

// --- VXI-11 core channel ---------------------------------------------------

/**
 * A link to one VXI-11 device. `write()` and `read()` are the primitives;
 * `query()` is the pair, with the reply assembled across as many device_read
 * calls as the instrument needs to deliver it.
 */
export class Vxi11Client {
  #rpc = null;
  #lid = null;
  #maxRecvSize = 1024;
  #queue = Promise.resolve();

  constructor({
    host,
    port = null,
    device = 'inst0',
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS,
  }) {
    this.host = host;
    this.port = port;
    this.device = device;
    this.connectTimeoutMs = connectTimeoutMs;
    this.ioTimeoutMs = ioTimeoutMs;
    /** set by the owner; called when the transport dies unprompted */
    this.onFatal = null;
  }

  get connected() {
    return !!this.#rpc?.connected && this.#lid !== null;
  }

  async connect() {
    let port = this.port;
    if (!port) {
      port = await getCorePort(this.host, { timeoutMs: this.connectTimeoutMs });
      if (!port) {
        throw new Error(
          `${this.host} answers RPC but does not offer a VXI-11 instrument (program ${DEVICE_CORE_PROG} is not registered)`
        );
      }
    }
    this.#rpc = new RpcClient({
      host: this.host,
      port,
      program: DEVICE_CORE_PROG,
      version: DEVICE_CORE_VERS,
      connectTimeoutMs: this.connectTimeoutMs,
    });
    this.#rpc.onClose = (reason) => {
      this.#lid = null;
      this.onFatal?.(reason);
    };
    await this.#rpc.connect();

    const args = new XdrWriter()
      .i32(process.pid & 0x7fffffff) // clientId
      .bool(false) // lockDevice
      .u32(0) // lock_timeout
      .string(this.device)
      .toBuffer();
    const r = await this.#rpc.call(CREATE_LINK, args, this.ioTimeoutMs);
    const error = r.i32();
    if (error !== 0) {
      this.#rpc.close();
      this.#rpc = null;
      throw new Vxi11Error(error, `create_link to "${this.device}"`);
    }
    this.#lid = r.i32();
    r.u32(); // abortPort — the abort channel is not used here
    this.#maxRecvSize = r.u32() || 1024;
    this.resolvedPort = port;
  }

  /** Run `fn` after every earlier operation on this link has finished. */
  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #requireLink() {
    if (!this.connected) {
      throw new Error(`no VXI-11 link to ${this.host} (${this.device})`);
    }
  }

  /** Write one complete message (a newline is appended if missing). */
  write(text) {
    return this.#serial(() => this.#write(text));
  }

  async #write(text) {
    this.#requireLink();
    const data = Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'latin1');
    // the instrument told us how much it accepts per call
    for (let offset = 0; offset < data.length; ) {
      const end = Math.min(data.length, offset + this.#maxRecvSize);
      const chunk = data.subarray(offset, end);
      const args = new XdrWriter()
        .i32(this.#lid)
        .u32(this.ioTimeoutMs)
        .u32(0) // lock_timeout
        .u32(end === data.length ? FLAG_END : 0)
        .opaque(chunk)
        .toBuffer();
      const r = await this.#rpc.call(
        DEVICE_WRITE,
        args,
        this.ioTimeoutMs + 1_000
      );
      const error = r.i32();
      if (error !== 0) throw new Vxi11Error(error, 'device_write');
      const written = r.u32();
      if (written === 0) throw new Error('device_write accepted no bytes');
      offset += written;
    }
  }

  /** Read one complete response (until END or the termination character). */
  read({ maxBytes = 4 * 1024 * 1024, timeoutMs = this.ioTimeoutMs } = {}) {
    return this.#serial(() => this.#read({ maxBytes, timeoutMs }));
  }

  async #read({ maxBytes, timeoutMs }) {
    this.#requireLink();
    const parts = [];
    let total = 0;
    for (;;) {
      const args = new XdrWriter()
        .i32(this.#lid)
        .u32(Math.min(maxBytes - total, 1024 * 1024)) // requestSize
        .u32(timeoutMs)
        .u32(0) // lock_timeout
        .u32(0) // flags: no termchr
        .u32(0x0a) // termChar (unused without the flag)
        .toBuffer();
      const r = await this.#rpc.call(DEVICE_READ, args, timeoutMs + 1_000);
      const error = r.i32();
      if (error !== 0) throw new Vxi11Error(error, 'device_read');
      const reason = r.u32();
      const data = r.opaque();
      parts.push(Buffer.from(data));
      total += data.length;
      if (reason & (REASON_END | REASON_CHR)) break;
      if (total >= maxBytes) break;
      if (!(reason & REASON_REQCNT) && data.length === 0) {
        throw new Error('device_read returned nothing and no end condition');
      }
    }
    return Buffer.concat(parts);
  }

  /** Write a query and read its complete reply as a trimmed string. */
  query(text, options) {
    return this.#serial(async () => {
      await this.#write(text);
      const buf = await this.#read({
        maxBytes: options?.maxBytes ?? 4 * 1024 * 1024,
        timeoutMs: options?.timeoutMs ?? this.ioTimeoutMs,
      });
      return buf.toString('latin1').trim();
    });
  }

  /** device_clear: flush the instrument's I/O buffers. */
  clear() {
    return this.#serial(async () => {
      this.#requireLink();
      const args = new XdrWriter()
        .i32(this.#lid)
        .u32(0) // flags
        .u32(0) // lock_timeout
        .u32(this.ioTimeoutMs)
        .toBuffer();
      const r = await this.#rpc.call(DEVICE_CLEAR, args, this.ioTimeoutMs + 1_000);
      const error = r.i32();
      if (error !== 0) throw new Vxi11Error(error, 'device_clear');
    });
  }

  /** Destroy the link and drop the connection. Never throws. */
  async close() {
    const rpc = this.#rpc;
    const lid = this.#lid;
    this.onFatal = null; // a close we asked for is not a fatal error
    this.#lid = null;
    this.#rpc = null;
    if (!rpc) return;
    rpc.onClose = null;
    if (lid !== null && rpc.connected) {
      try {
        const args = new XdrWriter().i32(lid).toBuffer();
        await rpc.call(DESTROY_LINK, args, 1_000);
      } catch {
        // the instrument may already be gone; the socket is closed regardless
      }
    }
    rpc.close();
  }
}
