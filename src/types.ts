export interface GrafanaConfig {
  url: string;
  // Browser-accessible URL used to build user-facing deep links into Grafana.
  // Separate from `url`, which is the API endpoint the server queries.
  publicUrl: string;
  // Template for the region-scoped Kibana/log host that several dashboards take
  // as a `log_url` variable. `{region}` is substituted with the human region
  // name, e.g. `log.prod-eu-central-1.ops.forge.timescale.com`.
  logHostTemplate: string;
  serviceAccountToken: string;
}

export interface ServerContext extends Record<string, unknown> {
  grafana: GrafanaConfig;
}
