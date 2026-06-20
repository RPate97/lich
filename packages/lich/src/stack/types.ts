export type ExecutorRef =
  | { kind: "local" }
  | { kind: "sandbox-tart"; vm_name: string };

export type DataSourceRef =
  | { kind: "local" }
  | { kind: "http"; base_url: string; stack_id: string };
