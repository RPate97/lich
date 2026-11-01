export function formatNotice(current: string, latest: string): string {
  return `lich ${current} is out of date — latest is ${latest}. Run \`lich update\` to upgrade.\n`;
}
