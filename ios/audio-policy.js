// This script runs at document start in every native QQPet WebView frame.
// Ruffle must not create a system WebAudio destination or an HTMLAudio unlock.
window.__qqpetRespectSystemAudio = true;
(() => {
  const contexts = new Map();
  const random = new Uint32Array(4);
  window.crypto.getRandomValues(random);
  const page = Array.from(random, value => value.toString(16).padStart(8, '0')).join('');
  let nextContext = 0, nextRequest = 0;
  const now = () => performance.now();
  const diagnostic = message => {
    window.__qqpetAudioPolicyState = 'native-audioqueue-error';
    window.__qqpetAudioPolicyError = String(message);
  };
  const bridge = () => window.webkit?.messageHandlers?.qqpetAudio;
  window.__qqpetAudioPolicyState = bridge() ? 'native-audioqueue' : 'native-audioqueue-unavailable';

  function checkedFormat(channels, frames, sampleRate) {
    if (channels !== 2 || sampleRate !== 44100 || !Number.isInteger(frames) || frames < 1024 || frames > 16384)
      throw new RangeError('QQPet AudioQueue requires stereo 44100 Hz buffers with 1024 to 16384 frames.');
  }
  function observed(promise) {
    // Ruffle's play/pause calls ignore the returned promises. Keep errors in the
    // policy diagnostic while preserving rejection for callers that await them.
    promise.catch(() => {});
    return promise;
  }
  function emit(target, name) {
    const event = new Event(name);
    const report = error => {
      try { console.error('QQPet AudioQueue event callback failed:', error); } catch { /* Reporting cannot interrupt cleanup. */ }
    };
    try { target.dispatchEvent(event); } catch (error) { report(error); }
    try {
      const callback = target['on' + name];
      if (typeof callback === 'function') callback.call(target, event);
    } catch (error) { report(error); }
  }
  class PCMBuffer {
    constructor(channels, frames, sampleRate) {
      checkedFormat(channels, frames, sampleRate);
      this.numberOfChannels = channels;
      this.length = frames;
      this.sampleRate = sampleRate;
      this.duration = frames / sampleRate;
      this._channels = [new Float32Array(frames), new Float32Array(frames)];
    }
    getChannelData(channel) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= this.numberOfChannels)
        throw new RangeError('AudioBuffer channel is out of range.');
      return this._channels[channel];
    }
    copyToChannel(source, channel, offset = 0) {
      const target = this.getChannelData(channel);
      if (!Number.isInteger(offset) || offset < 0 || offset >= this.length)
        throw new RangeError('AudioBuffer offset is out of range.');
      target.set(source.subarray(0, this.length - offset), offset);
    }
  }
  function encodePCM(buffer) {
    checkedFormat(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const bytes = new Uint8Array(buffer.length * 8);
    const view = new DataView(bytes.buffer);
    for (let frame = 0; frame < buffer.length; frame++) {
      for (let channel = 0; channel < 2; channel++) {
        const sample = buffer._channels[channel][frame];
        if (!Number.isFinite(sample)) throw new RangeError('AudioBuffer contains a non-finite sample.');
        view.setFloat32((frame * 2 + channel) * 4, sample, true);
      }
    }
    let binary = '';
    for (let index = 0; index < bytes.length; index += 4096)
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 4096));
    return btoa(binary);
  }
  class PCMSource extends EventTarget {
    constructor(context) {
      super();
      this.context = context;
      this.buffer = null;
      this.onended = null;
      this._source = 0;
      this._started = false;
      this._connected = false;
    }
    connect(destination) {
      if (destination !== this.context.destination) throw new Error('QQPet AudioQueue only supports its own destination.');
      this._connected = true;
      return destination;
    }
    start(when = 0, offset = 0, duration) {
      if (this._started) throw new Error('AudioBufferSource may only be started once.');
      if (this.context._closing || this.context._terminated) throw new Error('AudioContext is closed.');
      if (!this._connected || !(this.buffer instanceof PCMBuffer)) throw new Error('AudioBufferSource needs a buffer and destination.');
      if (!Number.isFinite(when) || when < 0) throw new RangeError('AudioBufferSource time is out of range.');
      if (offset !== 0 || duration !== undefined) throw new Error('QQPet AudioQueue does not support partial buffer playback.');
      // Ruffle reuses and rewrites each AudioBuffer from onended. Snapshot now,
      // even if the native create handshake has not acknowledged yet.
      const pcm = encodePCM(this.buffer);
      this._started = true;
      this._source = ++this.context._nextSource;
      this.context._sources.set(this._source, this);
      observed(this.context._afterCreate('enqueue', {
        source: this._source, frames: this.buffer.length, sampleRate: this.buffer.sampleRate,
        channels: this.buffer.numberOfChannels, when: this.context._scheduleTime(when), pcm,
      }));
    }
    stop() { throw new Error('QQPet AudioQueue does not support stopping an individual source.'); }
    disconnect() { throw new Error('QQPet AudioQueue does not support disconnecting an individual source.'); }
  }
  class PCMContext extends EventTarget {
    constructor(options = {}) {
      super();
      if (options.sampleRate !== undefined && options.sampleRate !== 44100)
        throw new RangeError('QQPet AudioQueue requires a 44100 Hz context.');
      if (typeof bridge()?.postMessage !== 'function') {
        diagnostic('The native AudioQueue bridge is unavailable.');
        throw new Error('QQPet AudioQueue bridge is unavailable.');
      }
      this.sampleRate = 44100;
      this.destination = Object.freeze({ context: this, numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2 });
      this.onstatechange = null;
      this._context = ++nextContext;
      this._nextSource = 0;
      this._sources = new Map();
      this._pending = new Map();
      this._state = 'suspended';
      this._time = 0;
      this._clockOffset = 0;
      this._lastReadTime = 0;
      this._anchor = now();
      this._closing = false;
      this._terminated = false;
      contexts.set(this._context, this);
      this._ready = this._post('create', { sampleRate: 44100, channels: 2 });
    }
    get state() { return this._state; }
    _nativeTime() {
      return this._time + (this._state === 'running' ? Math.max(0, now() - this._anchor) / 1000 : 0);
    }
    get currentTime() {
      const estimate = this._nativeTime() + this._clockOffset;
      // An asynchronous native snapshot may arrive after a later interpolated
      // value was read. Preserve monotonic reads without offsetting the native
      // anchor. A suspended context stays frozen at its last observed value.
      this._lastReadTime = Math.max(this._lastReadTime, estimate);
      return this._lastReadTime;
    }
    _scheduleTime(when) {
      // A delayed pause can leave the public monotonic clock ahead of the
      // queue. Both reads and absolute scheduling use the same stable epoch,
      // so repeated ping-pong refills cannot accumulate extra silent gaps.
      return Math.max(0, when - this._clockOffset);
    }
    _sync(message) {
      if (!Number.isFinite(message.time) || message.time < 0 || !['running', 'suspended', 'closed'].includes(message.state))
        throw new Error('Malformed native AudioQueue clock or state.');
      const changed = this._state !== message.state;
      if (changed && (message.state === 'suspended' || message.state === 'running')) {
        // Only a pause/resume boundary establishes a new virtual epoch. Late
        // running snapshots retain their native anchor and cannot drift it.
        this._clockOffset = Math.max(this._clockOffset, this._lastReadTime - message.time);
      }
      // Native AudioQueue time is authoritative; interpolation only bridges
      // native replies/completions, and never drives source completion.
      this._time = message.time;
      this._anchor = now();
      this._state = message.state;
      if (changed) emit(this, 'statechange');
    }
    _post(op, arguments_ = {}) {
      const request = ++nextRequest;
      const promise = new Promise((resolve, reject) => {
        this._pending.set(request, { op, resolve, reject });
        try {
          bridge().postMessage({ page, context: this._context, op, request, ...arguments_ });
        } catch (error) {
          this._finish(error instanceof Error ? error : new Error(String(error)), true);
        }
      });
      return observed(promise);
    }
    _afterCreate(op, arguments_ = {}) {
      return observed(this._ready.then(() => {
        if (this._terminated || (this._closing && op !== 'close')) throw new Error('AudioContext is closed.');
        return this._post(op, arguments_);
      }));
    }
    _clearSources() {
      for (const source of this._sources.values()) source.onended = null;
      this._sources.clear();
    }
    _finish(error, failed = false) {
      if (this._terminated) return;
      this._terminated = true;
      this._closing = true;
      this._clearSources();
      const time = this.currentTime;
      contexts.delete(this._context);
      for (const pending of this._pending.values()) pending.reject(error);
      this._pending.clear();
      if (failed) {
        diagnostic(error.message);
        try {
          bridge()?.postMessage({ page, context: this._context, op: 'close', request: ++nextRequest });
        } catch { /* The failed bridge may already have gone away. */ }
      }
      // All internal ownership and promise cleanup precedes user callbacks.
      this._sync({ time: time - this._clockOffset, state: 'closed' });
    }
    createBuffer(channels, frames, sampleRate) {
      if (this._closing) throw new Error('AudioContext is closed.');
      return new PCMBuffer(channels, frames, sampleRate);
    }
    createBufferSource() {
      if (this._closing) throw new Error('AudioContext is closed.');
      return new PCMSource(this);
    }
    resume() { return this._afterCreate('resume'); }
    suspend() { return this._afterCreate('suspend'); }
    close() {
      if (this._closePromise) return this._closePromise;
      if (this._terminated) return Promise.resolve();
      this._closing = true;
      this._clearSources();
      this._closePromise = this._afterCreate('close');
      this._sync({ time: this.currentTime - this._clockOffset, state: 'closed' });
      return this._closePromise;
    }
  }
  window.__qqpetNativeAudioReceive = message => {
    if (!message || message.page !== page) return;
    const context = contexts.get(message.context);
    if (!context || context._terminated) return;
    if (!['reply', 'ended', 'state'].includes(message.type)) return;
    const pending = message.type === 'reply' ? context._pending.get(message.request) : null;
    if (message.type === 'reply' && !pending) return;
    const source = message.type === 'ended' ? context._sources.get(message.source) : null;
    if (message.type === 'ended' && (!source || context._closing)) return;
    try {
      if (message.error) throw new Error(String(message.error));
      if (!context._closing || pending?.op === 'close') context._sync(message);
      if (message.state === 'closed' && pending?.op !== 'close') {
        context._finish(new Error('Native AudioQueue closed.'));
        return;
      }
      if (message.type === 'reply') {
        context._pending.delete(message.request);
        pending.resolve();
        if (pending.op === 'close') context._finish(new Error('AudioContext is closed.'));
        // A healthy sibling player must not hide this document's earlier fault.
        else if (window.__qqpetAudioPolicyState !== 'native-audioqueue-error') window.__qqpetAudioPolicyState = 'native-audioqueue';
      } else if (message.state === 'closed') {
        context._finish(new Error('Native AudioQueue closed.'));
      } else if (message.type === 'ended' && !context._closing) {
        context._sources.delete(message.source);
        emit(source, 'ended');
      }
    } catch (error) {
      context._finish(error instanceof Error ? error : new Error(String(error)), true);
    }
  };
  window.AudioContext = PCMContext;
  window.webkitAudioContext = PCMContext;
  window.addEventListener('pagehide', () => {
    for (const context of [...contexts.values()]) {
      // create was already posted synchronously, so the native FIFO can close
      // it even while its acknowledgement is still in flight.
      observed(context._post('close'));
      context._finish(new Error('AudioContext document was closed.'));
    }
  });
})();
