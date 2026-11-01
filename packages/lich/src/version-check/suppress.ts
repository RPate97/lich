export interface SuppressInput {
  argv: {
    json?: boolean;
    quiet?: boolean;
    version?: boolean;
  };
  env: NodeJS.ProcessEnv;
  commandName: string | undefined;
}

export function shouldSuppressNotice(input: SuppressInput): boolean {
  if (envTruthy(input.env.LICH_NO_UPDATE_CHECK)) return true;
  if (input.argv.json === true) return true;
  if (input.argv.quiet === true) return true;
  if (input.argv.version === true) return true;
  if (input.commandName === "update") return true;
  if (input.commandName === "__update-check-refresh") return true;
  return false;
}

function envTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
