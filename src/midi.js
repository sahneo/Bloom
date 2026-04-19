// ---------------------------------------------------------------------------
// Web MIDI API handler
//
// Prerequisites (macOS):
//   1. Open Audio MIDI Setup → Window → Show MIDI Studio
//   2. Double-click "IAC Driver" → enable "Device is online"
//   3. In Ableton: Preferences → Link/Tempo/MIDI → enable IAC Bus as MIDI Out
// ---------------------------------------------------------------------------

export class MIDIHandler {
  constructor({ onNoteOn, onNoteOff }) {
    this.onNoteOn  = onNoteOn;
    this.onNoteOff = onNoteOff;
    this._access   = null;
  }

  get isSupported() {
    return !!navigator.requestMIDIAccess;
  }

  async connect(testMode = false) {
    this._testMode = testMode;
    if (!this.isSupported) {
      throw new Error('Web MIDI API not supported in this browser. Use Chrome.');
    }

    this._access = await navigator.requestMIDIAccess({ sysex: false });
    this._listenToAll();

    // Re-connect when devices are plugged/unplugged
    this._access.onstatechange = () => this._listenToAll();

    return this._inputNames();
  }

  disconnect() {
    if (!this._access) return;
    for (const input of this._access.inputs.values()) {
      input.onmidimessage = null;
    }
  }

  _listenToAll() {
    for (const input of this._access.inputs.values()) {
      input.onmidimessage = (e) => this._handleMessage(e);
    }
  }

  _handleMessage({ data }) {
    const [status, pitch, velocity] = data;
    const type    = status & 0xf0;
    const channel = status & 0x0f;

    if (type === 0x90 && velocity > 0) {
      this.onNoteOn(pitch, velocity, channel);
    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      this.onNoteOff(pitch, channel);
    }
  }

  _inputNames() {
    return [...this._access.inputs.values()].map(i => i.name);
  }
}
