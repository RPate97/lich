import { spawn } from "node:child_process";
import { platform } from "node:os";

/** Spawn the OS's default URL handler on `url`. Detached + unref'd; not awaited. */
export function openInBrowser(url: string): void {
  const plat = platform();
  let command: string;
  if (plat === "darwin") {
    command = "open";
  } else if (plat === "linux") {
    command = "xdg-open";
  } else if (plat === "win32") {
    command = "start";
  } else {
    throw new Error(`unsupported platform for browser open: ${plat}`);
  }

  const child = spawn(command, [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
