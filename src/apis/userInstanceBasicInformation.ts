import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import { DATA_SOURCES } from '../data_sources.js';
import type { ServerContext } from '../types.js';
import {
  getValues,
  queryGrafanaPostgresQueries,
  queryGrafanaPrometheusQueries,
} from '../util/grafana.js';

// Dashboard targeted by the user-facing deep link.
const USER_INSTANCE_DASHBOARD_PATH = 'd/3lvO6U-Zz/user-instance-single';

const inputSchema = {
  projectId: z.string().describe('The project ID.'),
  serviceId: z.string().describe('The service ID.'),
  postgresDatasourceUid: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'Postgres datasource UID. Pass null to use the server default for the active deploy environment.',
    ),
  prometheusDatasourceUid: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'Prometheus datasource UID. Pass null to use the server default for the active deploy environment.',
    ),
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
      'Grafana deep link to the user-instance-single dashboard for this project/service.',
    ),
} as const;

type OutputSchema = InferSchema<typeof outputSchema>;
type InputSchema = InferSchema<typeof inputSchema>;

const sqlString = (value: string): string => value.replaceAll("'", "''");

const normalizeInput = ({
  projectId,
  serviceId,
  postgresDatasourceUid,
  prometheusDatasourceUid,
}: InputSchema): {
  postgresUid: string;
  prometheusUid: string;
  sqlProjectId: string;
  sqlServiceId: string;
} => ({
  postgresUid: postgresDatasourceUid || DATA_SOURCES.postgresUid,
  prometheusUid: prometheusDatasourceUid || DATA_SOURCES.prometheusThanosUid,
  sqlProjectId: sqlString(projectId),
  sqlServiceId: sqlString(serviceId),
});

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
  fn: async ({
    projectId,
    serviceId,
    postgresDatasourceUid,
    prometheusDatasourceUid,
  }): Promise<OutputSchema> => {
    const { postgresUid, prometheusUid, sqlProjectId, sqlServiceId } =
      normalizeInput({
        projectId,
        serviceId,
        postgresDatasourceUid,
        prometheusDatasourceUid,
      });

    const [postgresVersionResult, timescaledbResult] = await Promise.all([
      queryGrafanaPrometheusQueries(ctx.grafana, {
        datasourceUid: prometheusUid,
        queries: [
          {
            refId: 'major',
            expr: `pg_settings_server_version_num{projectid="${projectId}", serviceid="${serviceId}"} / 10000`,
          },
          {
            refId: 'minor',
            expr: `pg_settings_server_version_num{projectid="${projectId}", serviceid="${serviceId}"} % 10000`,
          },
        ],
      }),
      queryGrafanaPostgresQueries(ctx.grafana, {
        datasourceUid: postgresUid,
        queries: [
          {
            refId: 'timescaledb',
            sql: `SELECT extension_version FROM deployer.instance_extensions WHERE project_id = '${sqlProjectId}' AND service_id = '${sqlServiceId}' AND extension_name = 'timescaledb' AND status = 'Add' ORDER BY created DESC LIMIT 1`,
          },
        ],
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

    const dashboardUrl =
      `${ctx.grafana.publicUrl}/${USER_INSTANCE_DASHBOARD_PATH}` +
      `?var-project=${encodeURIComponent(projectId)}` +
      `&var-service=${encodeURIComponent(serviceId)}`;

    return {
      postgresqlVersion: formattedPostgresqlVersion,
      timescaledbVersion: formattedTsDbVersion,
      dashboardUrl,
    };
  },
});
