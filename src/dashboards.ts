import { PROMETHEUS_THANOS_UID } from './util/datasources.js';

/**
 * Values available to a dashboard's template variables. Any field may be null
 * when it could not be resolved; a null variable is omitted from the deep link
 * so Grafana falls back to the dashboard's own default.
 */
export type DashboardContext = {
  projectId: string;
  serviceId: string;
  /** Human region name, e.g. `eu-central-1`. */
  region: string | null;
  /** UID of the Prometheus datasource for `region`. */
  promDatasourceUid: string | null;
  /** Region-scoped log host, e.g. `log.prod-eu-central-1.ops.forge.timescale.com`. */
  logHost: string | null;
  /** Primary Postgres member pod, e.g. `jzfulctix1-an-0`. */
  instancePod: string | null;
  /** Postgres source connector container, e.g. `pgsrc-connector`. */
  connectorAppName: string | null;
};

export type DashboardDefinition = {
  uid: string;
  /**
   * URL slug. Cosmetic, since Grafana resolves `d/<uid>` and redirects to
   * the canonical slug, but including it keeps shared links self-describing.
   */
  slug: string;
  title: string;
  description: string;
  /** Whether the dashboard needs connector-specific values resolved. */
  needsConnector: boolean;
  vars: (ctx: DashboardContext) => Record<string, string | null>;
};

/**
 * WARNING: `region` does not mean the same thing on every dashboard.
 *
 * - `user-instance` and `pooler` follow the older convention where the human
 *   region lives in `plain_region` and `region`/`datasource` holds a Grafana
 *   datasource UID.
 * - `pg-connector` inverts it: `region` is the human region and the datasource
 *   UID lives in `prom_region`.
 *
 * Filling the wrong one yields a link that loads but renders another region's
 * data, so each definition below spells out its own mapping rather than sharing
 * a single "region" field.
 */
export const DASHBOARDS = {
  'user-instance': {
    uid: '3lvO6U-Zz',
    slug: 'user-instance-single',
    title: 'User Instance (single)',
    description:
      'Generic per-service Postgres instance view: CPU, memory, disk, connections, query stats.',
    needsConnector: false,
    vars: (ctx) => ({
      project: ctx.projectId,
      service: ctx.serviceId,
      plain_region: ctx.region,
      region: ctx.promDatasourceUid,
      log_url: ctx.logHost,
    }),
  },
  'pg-connector': {
    uid: 'ce903ba2-882e-48e4-b474-e8f34fc197cf',
    slug: 'postgres-livesync-single-user',
    title: 'Postgres Livesync (single user)',
    description:
      'Per-service Postgres source connector (livesync) view: replication lag, apply/flush LSN, sync state. The dashboard to use for PgConnector* alerts.',
    needsConnector: true,
    vars: (ctx) => ({
      project_id: ctx.projectId,
      service_id: ctx.serviceId,
      region: ctx.region,
      prom_region: ctx.promDatasourceUid,
      app_name: ctx.connectorAppName,
      pod: ctx.instancePod,
      log_url: ctx.logHost,
    }),
  },
  'connector-k8s-events': {
    uid: 'connector-k8s-events',
    slug: 'connector-k8s-events',
    title: 'Connector K8s Events',
    description:
      'Kubernetes events for connector workloads: restarts, evictions, scheduling failures.',
    needsConnector: false,
    vars: (ctx) => ({
      region: ctx.promDatasourceUid,
    }),
  },
  tigerlake: {
    uid: 'tigerlake',
    slug: 'tigerlake-performance',
    title: 'Tigerlake Performance',
    description:
      'Per-service Tigerlake (Iceberg destination) connector throughput and latency.',
    needsConnector: false,
    vars: (ctx) => ({
      project: ctx.projectId,
      service: ctx.serviceId,
      // Authored against the cross-region Thanos datasource rather than a
      // per-region one.
      region: PROMETHEUS_THANOS_UID,
    }),
  },
  pooler: {
    uid: 'aek-7cbd6b6f87',
    slug: 'connection-pooler',
    title: 'Connection Pooler',
    description:
      'Per-service connection pooler view: client/server connections, pool saturation, wait times.',
    needsConnector: false,
    vars: (ctx) => ({
      project: ctx.projectId,
      service: ctx.serviceId,
      plain_region: ctx.region,
      datasource: ctx.promDatasourceUid,
      log_url: ctx.logHost,
    }),
  },
} as const satisfies Record<string, DashboardDefinition>;

export type DashboardKey = keyof typeof DASHBOARDS;

export const DASHBOARD_KEYS = Object.keys(DASHBOARDS) as [
  DashboardKey,
  ...DashboardKey[],
];

/**
 * Build a Grafana deep link. Variables that resolved to null are left out so
 * the dashboard applies its own default instead of rendering an empty
 * selection.
 */
export const buildDashboardUrl = (
  publicUrl: string,
  definition: DashboardDefinition,
  ctx: DashboardContext,
  { from, to }: { from: string; to: string },
): { url: string; vars: Record<string, string>; missing: string[] } => {
  const params = new URLSearchParams({
    orgId: '1',
    from,
    to,
    timezone: 'utc',
  });

  const vars: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, value] of Object.entries(definition.vars(ctx))) {
    if (value == null) {
      missing.push(name);
      continue;
    }
    params.set(`var-${name}`, value);
    vars[name] = value;
  }

  return {
    url: `${publicUrl}/d/${definition.uid}/${definition.slug}?${params}`,
    vars,
    missing,
  };
};
