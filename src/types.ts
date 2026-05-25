export interface GrafanaConfig {
  url: string;
  serviceAccountToken: string;
}

export interface ServerContext extends Record<string, unknown> {
  grafana: GrafanaConfig;
}
