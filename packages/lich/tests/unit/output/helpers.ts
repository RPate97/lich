import { Writable } from "node:stream";

/** Writable that buffers writes into a string for test assertions. */
export interface CapturedStream extends Writable {
  text: string;
  lines(): string[];
}

export function makeSink(): CapturedStream {
  const sink = new Writable({
    write(chunk, _encoding, callback): void {
      (sink as CapturedStream).text += chunk.toString();
      callback();
    },
  }) as CapturedStream;
  sink.text = "";
  // force non-TTY: deterministic plain-line path, no spinner timers or cursor escapes
  (sink as unknown as { isTTY: boolean }).isTTY = false;
  sink.lines = function lines(): string[] {
    const parts = this.text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  };
  return sink;
}
