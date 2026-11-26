import readline from 'node:readline';
import { PassThrough } from 'node:stream';
// Paste is decoded before readline: an entire paste is one edit, never commands.
export class InputDecoder {
  constructor(onKey, onPaste) {
    this.stream = new PassThrough();
    readline.emitKeypressEvents(this.stream, { escapeCodeTimeout: 40 });
    this.stream.on('keypress', (value, key = {}) => onKey(value, key));
    this.onPaste = onPaste;
    this.pending = '';
    this.paste = null;
  }
  feed(chunk) {
    this.pending += chunk;
    while (this.pending) {
      const marker = this.paste === null ? '\x1b[200~' : '\x1b[201~';
      const index = this.pending.indexOf(marker);
      if (index >= 0) {
        const value = this.pending.slice(0, index);
        if (this.paste === null) {
          this.stream.write(value);
          this.paste = '';
        } else {
          this.onPaste(this.paste + value);
          this.paste = null;
        }
        this.pending = this.pending.slice(index + marker.length);
        continue;
      }
      let suffix = 0;
      for (let size = 1; size < marker.length; size++)
        if (this.pending.endsWith(marker.slice(0, size))) suffix = size;
      const value = this.pending.slice(0, this.pending.length - suffix);
      if (this.paste === null) this.stream.write(value);
      else this.paste += value;
      this.pending = this.pending.slice(this.pending.length - suffix);
      break;
    }
  }
  flush() {
    if (this.paste === null && this.pending) {
      this.stream.write(this.pending);
      this.pending = '';
    }
  }
}
