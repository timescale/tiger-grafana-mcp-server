export interface GrafanaConfig {
  url: string;
  // Browser-accessible URL used to build user-facing deep links into Grafana.
  // Separate from `url`, which is the API endpoint the server queries.
  publicUrl: string;
  serviceAccountToken: string;
}

export interface ServerContext extends Record<string, unknown> {
  grafana: GrafanaConfig;
}
