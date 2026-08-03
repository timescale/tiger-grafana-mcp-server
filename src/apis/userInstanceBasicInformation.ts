import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import { buildDashboardUrl, DASHBOARDS } from '../dashboards.js';
import type { ServerContext } from '../types.js';
import { resolveDashboardContext } from '../util/dashboardContext.js';
import { POSTGRES_UID, PROMETHEUS_THANOS_UID } from '../util/datasources.js';
import {
  getValues,
  promLabelValue,
  queryGrafanaPostgresQueries,
  queryGrafanaPrometheusQueries,
} from '../util/grafana.js';

// Dashboard targeted by the user-facing deep link. For other dashboards (the
// Postgres livesync connector, the pooler, ...) use `grafana_dashboard_link`.
const DASHBOARD = DASHBOARDS['user-instance'];

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
  dashboardUrl: z
    .string()
    .describe(
      'Grafana deep link to the user-instance-single dashboard for this project/service, scoped to the region the service actually runs in.',
    ),
  region: z
    .string()
    .nullable()
    .describe('Region the service was resolved to, e.g. "eu-central-1".'),
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
    const promProjectId = promLabelValue(projectId);
    const promServiceId = promLabelValue(serviceId);

    const [postgresVersionResult, timescaledbResult, dashboardContext] =
      await Promise.all([
        queryGrafanaPrometheusQueries(ctx.grafana, {
          datasourceUid: PROMETHEUS_THANOS_UID,
          queries: [
            {
              refId: 'major',
              expr: `max(last_over_time(pg_settings_server_version_num{projectid="${promProjectId}", serviceid="${promServiceId}"}[30d])) / 10000`,
            },
            {
              refId: 'minor',
              expr: `max(last_over_time(pg_settings_server_version_num{projectid="${promProjectId}", serviceid="${promServiceId}"}[30d])) % 10000`,
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
          ],
        }),
        resolveDashboardContext(ctx, {
          projectId,
          serviceId,
          needsConnector: DASHBOARD.needsConnector,
        }),
      ]);

    const tsDbVersion =
      getValues(timescaledbResult, 'timescaledb')?.[0]?.[0] ?? null;
    const major = getValues(postgresVersionResult, 'major')?.[1]?.[0] ?? null;
    const minor = getValues(postgresVersionResult, 'minor')?.[1]?.[0] ?? null;

    const formattedPostgresqlVersion =
      major == null
        ? null
        : minor == null
          ? String(Math.floor(Number(major)))
          : `${Math.floor(Number(major))}.${String(minor)}`;
    const formattedTsDbVersion =
      tsDbVersion == null ? null : String(tsDbVersion);

    const { url: dashboardUrl } = buildDashboardUrl(
      ctx.grafana.publicUrl,
      DASHBOARD,
      dashboardContext.context,
      { from: 'now-24h', to: 'now' },
    );

    return {
      postgresqlVersion: formattedPostgresqlVersion,
      timescaledbVersion: formattedTsDbVersion,
      dashboardUrl,
      region: dashboardContext.context.region,
    };
  },
});
