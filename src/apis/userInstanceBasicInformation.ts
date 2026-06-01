import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  getValues,
  queryGrafanaPostgresQueries,
  queryGrafanaPrometheusQueries,
} from '../util/grafana.js';

// Grafana datasource UIDs. Same UIDs on dev and prod (Grafanas provisioned
// with deterministic UIDs).
const PROMETHEUS_THANOS_UID = 'P7C88DFFA3330979B'; // "All Prometheus regions (Thanos)"
const POSTGRES_UID = 'PDD8BC545CD76D0F3'; // "PostgreSQL (Grafana)" — exposes deployer schema

// Dashboard targeted by the user-facing deep link.
const USER_INSTANCE_DASHBOARD_PATH = 'd/3lvO6U-Zz/user-instance-single';

const inputSchema = {
  projectId: z.string().describe('The project ID.'),
  serviceId: z.string().describe('The service ID.'),
} as const;

const outputSchema = {
  postgresqlVersion: z
    .string()
    .nullable()
    .describe('PostgreSQL version built from major and minor metrics.'),
  timescaledbVersion: z
    .string()
    .nullable()
    .describe(
      'TimescaleDB extension version from deployer.instance_extensions.',
    ),
  region: z
    .string()
    .nullable()
    .describe('Cloud region where the service is deployed, e.g. "us-east-1".'),
  plan: z
    .string()
    .nullable()
    .describe(
      'Subscription plan: "Free", "Performance", "Scale", or "Enterprise".',
    ),
  cpuCores: z
    .number()
    .nullable()
    .describe('Allocated CPU cores per instance.'),
  memoryGb: z
    .number()
    .nullable()
    .describe('Allocated memory in GB per instance.'),
  replicaCount: z
    .number()
    .nullable()
    .describe('Number of read replicas configured (0 = none).'),
  isRunning: z
    .boolean()
    .nullable()
    .describe('Whether the service is enabled (not disabled in deployer DB).'),
  isPostgresUp: z
    .boolean()
    .nullable()
    .describe('Whether the postgres exporter reports the database as up.'),
  diskUsagePercent: z
    .number()
    .nullable()
    .describe(
      'Disk fullness across primary PVCs (0-100). >85 warning, >95 critical.',
    ),
  diskGrowthGbPerDay: z
    .number()
    .nullable()
    .describe(
      'Average disk growth in GB/day over the last 7 days. Combine with diskUsagePercent to estimate time-to-full.',
    ),
  oomEventsLast7d: z
    .number()
    .nullable()
    .describe(
      'Number of Kubernetes-level OOM kill events for the service in the last 7 days. >0 indicates memory pressure.',
    ),
  avgCpuCoresLast7d: z
    .number()
    .nullable()
    .describe(
      'Average CPU cores consumed by the postgres container over the last 7 days. Divide by cpuCores for utilization %.',
    ),
  dashboardUrl: z
    .string()
    .describe(
      'Grafana deep link to the user-instance-single dashboard for this project/service.',
    ),
} as const;

type OutputSchema = InferSchema<typeof outputSchema>;

const sqlString = (value: string): string => value.replaceAll("'", "''");

export const userInstanceBasicInformation: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = (ctx) => ({
  name: 'user_instance_basic_information',
  method: 'post',
  route: '/user-instance-basic-information',
  config: {
    title: 'User Instance Basic Information',
    description:
      'Fetch PostgreSQL and TimescaleDB versions for a user instance.',
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  fn: async ({ projectId, serviceId }): Promise<OutputSchema> => {
    const sqlProjectId = sqlString(projectId);
    const sqlServiceId = sqlString(serviceId);

    const [prometheusResult, postgresResult] = await Promise.all([
      queryGrafanaPrometheusQueries(ctx.grafana, {
        datasourceUid: PROMETHEUS_THANOS_UID,
        queries: [
          {
            refId: 'major',
            expr: `max(last_over_time(pg_settings_server_version_num{projectid="${projectId}", serviceid="${serviceId}"}[30d])) / 10000`,
          },
          {
            refId: 'minor',
            expr: `max(last_over_time(pg_settings_server_version_num{projectid="${projectId}", serviceid="${serviceId}"}[30d])) % 10000`,
          },
          {
            refId: 'pg_up',
            expr: `max(last_over_time(pg_up{projectid="${projectId}", serviceid="${serviceId}", container="metrics", application="utilities"}[30d]))`,
          },
          {
            refId: 'disk_used',
            expr: `max(last_over_time(kubelet_volume_stats_used_bytes{namespace="${projectId}", persistentvolumeclaim=~"pgdata-${serviceId}-an-[0-9]+"}[30d]))`,
          },
          {
            refId: 'disk_cap',
            expr: `max(last_over_time(kubelet_volume_stats_capacity_bytes{namespace="${projectId}", persistentvolumeclaim=~"pgdata-${serviceId}-an-[0-9]+"}[30d]))`,
          },
          {
            refId: 'disk_growth_bytes_per_day',
            expr: `max(delta(kubelet_volume_stats_used_bytes{namespace="${projectId}", persistentvolumeclaim=~"pgdata-${serviceId}-an-[0-9]+"}[7d]) / 7)`,
          },
          {
            refId: 'oom_events_7d',
            expr: `sum(increase(container_oom_events_total{namespace="${projectId}", pod=~"${serviceId}-an-[0-9]+"}[7d]))`,
          },
          {
            refId: 'avg_cpu_cores_7d',
            expr: `max(delta(container_cpu_usage_seconds_total{namespace="${projectId}", pod=~"${serviceId}-an-[0-9]+", container="postgres"}[7d]) / (7 * 86400))`,
          },
        ],
      }),
      queryGrafanaPostgresQueries(ctx.grafana, {
        datasourceUid: POSTGRES_UID,
        queries: [
          {
            refId: 'timescaledb',
            sql: `SELECT extension_version FROM deployer.instance_extensions WHERE project_id = '${sqlProjectId}' AND service_id = '${sqlServiceId}' AND extension_name = 'timescaledb' AND status = 'Add' ORDER BY created DESC LIMIT 1`,
          },
          {
            refId: 'service_info',
            sql: `SELECT (svc.disabled IS NULL) AS is_running, loc.region FROM projects.service svc JOIN projects.locations loc ON svc.location_id = loc.id WHERE svc.id = '${sqlServiceId}' AND svc.project_id = '${sqlProjectId}'`,
          },
          {
            refId: 'plan',
            sql: `SELECT CASE WHEN last(sub.plan_id, sub.activated) = 'plan_performance_virtual_plan' THEN 'Performance' WHEN last(sub.plan_id, sub.activated) = 'plan_scale_virtual_plan' THEN 'Scale' WHEN last(sub.plan_id, sub.activated) = 'plan_enterprise_virtual_plan' THEN 'Enterprise' WHEN last(sub.plan_id, sub.activated) = 'plan_free_virtual_plan' THEN 'Free' END AS plan FROM billing.subscriptions AS sub WHERE sub.project_id = '${sqlProjectId}' AND sub.plan_id IN ('plan_free_virtual_plan', 'plan_performance_virtual_plan', 'plan_scale_virtual_plan', 'plan_enterprise_virtual_plan')`,
          },
          {
            refId: 'resource_spec',
            sql: `SELECT (t1.spec ->> 'cpu')::BIGINT / 1000.0 AS cpu_cores, (t1.spec ->> 'memory_gb')::BIGINT AS memory_gb, COALESCE((t1.spec ->> 'replica_count')::BIGINT, 0) AS replica_count FROM (SELECT LAST(spec, resource_spec.created) AS spec FROM projects.resource JOIN projects.resource_spec ON resource.id = resource_spec.resource_id WHERE service_id = '${sqlServiceId}') AS t1`,
          },
        ],
      }),
    ]);

    const tsDbVersion =
      getValues(postgresResult, 'timescaledb')?.[0]?.[0] ?? null;
    const major = getValues(prometheusResult, 'major')?.[1]?.[0] ?? null;
    const minor = getValues(prometheusResult, 'minor')?.[1]?.[0] ?? null;

    const pgUpRaw = getValues(prometheusResult, 'pg_up')?.[1]?.[0] ?? null;
    const diskUsedRaw =
      getValues(prometheusResult, 'disk_used')?.[1]?.[0] ?? null;
    const diskCapRaw =
      getValues(prometheusResult, 'disk_cap')?.[1]?.[0] ?? null;

    const serviceInfoValues = getValues(postgresResult, 'service_info');
    const isRunningRaw = serviceInfoValues?.[0]?.[0] ?? null;
    const region = (serviceInfoValues?.[1]?.[0] as string | null) ?? null;
    const plan = (getValues(postgresResult, 'plan')?.[0]?.[0] as
      | string
      | null) ?? null;

    const resourceSpecValues = getValues(postgresResult, 'resource_spec');
    const cpuCoresRaw = resourceSpecValues?.[0]?.[0] ?? null;
    const memoryGbRaw = resourceSpecValues?.[1]?.[0] ?? null;
    const replicaCountRaw = resourceSpecValues?.[2]?.[0] ?? null;

    const formattedPostgresqlVersion =
      major == null
        ? null
        : minor == null
          ? String(Math.floor(Number(major)))
          : `${Math.floor(Number(major))}.${String(minor)}`;
    const formattedTsDbVersion =
      tsDbVersion == null ? null : String(tsDbVersion);

    const isPostgresUp =
      pgUpRaw == null ? null : Number(pgUpRaw) > 0;
    const isRunning =
      isRunningRaw == null ? null : Boolean(isRunningRaw);
    const cpuCores = cpuCoresRaw == null ? null : Number(cpuCoresRaw);
    const memoryGb = memoryGbRaw == null ? null : Number(memoryGbRaw);
    const replicaCount =
      replicaCountRaw == null ? null : Number(replicaCountRaw);

    const diskUsed = diskUsedRaw == null ? null : Number(diskUsedRaw);
    const diskCap = diskCapRaw == null ? null : Number(diskCapRaw);
    const diskUsagePercent =
      diskUsed == null || diskCap == null || diskCap === 0
        ? null
        : Math.round((diskUsed / diskCap) * 1000) / 10;

    const diskGrowthBytesPerDayRaw =
      getValues(prometheusResult, 'disk_growth_bytes_per_day')?.[1]?.[0] ?? null;
    const diskGrowthGbPerDay =
      diskGrowthBytesPerDayRaw == null
        ? null
        : Math.round((Number(diskGrowthBytesPerDayRaw) / 1e9) * 100) / 100;

    const oomEventsRaw =
      getValues(prometheusResult, 'oom_events_7d')?.[1]?.[0] ?? null;
    const oomEventsLast7d =
      oomEventsRaw == null ? null : Math.round(Number(oomEventsRaw));

    const avgCpuCoresRaw =
      getValues(prometheusResult, 'avg_cpu_cores_7d')?.[1]?.[0] ?? null;
    const avgCpuCoresLast7d =
      avgCpuCoresRaw == null
        ? null
        : Math.round(Number(avgCpuCoresRaw) * 1000) / 1000;

    const dashboardUrl =
      `${ctx.grafana.publicUrl}/${USER_INSTANCE_DASHBOARD_PATH}` +
      `?var-project=${encodeURIComponent(projectId)}` +
      `&var-service=${encodeURIComponent(serviceId)}`;

    return {
      postgresqlVersion: formattedPostgresqlVersion,
      timescaledbVersion: formattedTsDbVersion,
      region,
      plan,
      cpuCores,
      memoryGb,
      replicaCount,
      isRunning,
      isPostgresUp,
      diskUsagePercent,
      diskGrowthGbPerDay,
      oomEventsLast7d,
      avgCpuCoresLast7d,
      dashboardUrl,
    };
  },
});
