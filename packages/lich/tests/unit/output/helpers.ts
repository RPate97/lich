import { Writable } from "node:stream";

/**
 * A WritableStream that buffers everything written to it into a string.
 * Tests assert on `sink.text` after driving an Output.
 *
 * `isTTY` is forced to false so the pretty printer takes the
 * deterministic plain-line path (no spinner timers, no cursor escapes).
 */
export interface CapturedStream extends Writable {
  text: string;
  /** Convenience: text split on \n with trailing empty element dropped. */
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
  // Force non-TTY behavior so tests are deterministic.
  (sink as unknown as { isTTY: boolean }).isTTY = false;
  sink.lines = function lines(): string[] {
    const parts = this.text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  };
  return sink;
}
