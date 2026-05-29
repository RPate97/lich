#!/usr/bin/env bun
import { runDaemon } from "../daemon/daemon.js";
import {
  getEmbeddedAsset,
  hasEmbeddedAssets,
} from "../daemon/dashboard/embedded-ui.generated.js";

const lichHome = process.env.LICH_HOME;
const proxyPortRaw = process.env.LICH_PROXY_PORT;
let proxyPort: number | undefined;
if (proxyPortRaw && proxyPortRaw.length > 0) {
  const parsed = parseInt(proxyPortRaw, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) {
    proxyPort = parsed;
  } else {
    process.stderr.write(
      `lich-daemon: invalid LICH_PROXY_PORT '${proxyPortRaw}'; using default\n`,
    );
  }
}

// LICH_UI_DIR overrides the embedded SPA bundle; no existsSync so a bad path fails loudly.
const uiDir =
  process.env.LICH_UI_DIR && process.env.LICH_UI_DIR.length > 0
    ? process.env.LICH_UI_DIR
    : undefined;

const embeddedUi = hasEmbeddedAssets() ? { get: getEmbeddedAsset } : undefined;

const { exitCode } = await runDaemon({
  lichHome,
  proxyPort,
  uiDir,
  embeddedUi,
});
process.exit(exitCode);
