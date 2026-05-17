export interface URLEntry {
  host: string;
  target: string;
  service?: string;
}

export interface PortlessAdapter {
  name: string;
  available(): Promise<boolean>;
  register(input: { host: string; target: string }): Promise<void>;
  unregister(host: string): Promise<void>;
  list(): Promise<URLEntry[]>;
}
