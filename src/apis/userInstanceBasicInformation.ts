import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import {
  getValues,
  queryGrafanaPostgresQueries,
  queryGrafanaPrometheusQueries,
} from '../util/grafana.js';

// Default Grafana datasources used by the dev Grafana instance.
const DEFAULT_POSTGRES_DATASOURCE_UID = 'PDD8BC545CD76D0F3';
const DEFAULT_PROMETHEUS_DATASOURCE_UID = 'P7BFACEA27D7DF090';

const inputSchema = {
  projectId: z.string().describe('The project ID.'),
  serviceId: z.string().describe('The service ID.'),
  postgresDatasourceUid: z
    .string()
    .nullable()
    .default(null)
    .describe(
      `Postgres datasource UID. Pass null to use ${DEFAULT_POSTGRES_DATASOURCE_UID}.`,
    ),
  prometheusDatasourceUid: z
    .string()
    .nullable()
    .default(null)
    .describe(
      `Prometheus datasource UID. Pass null to use ${DEFAULT_PROMETHEUS_DATASOURCE_UID}.`,
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
  postgresUid: postgresDatasourceUid || DEFAULT_POSTGRES_DATASOURCE_UID,
  prometheusUid: prometheusDatasourceUid || DEFAULT_PROMETHEUS_DATASOURCE_UID,
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

    return {
      postgresqlVersion: formattedPostgresqlVersion,
      timescaledbVersion: formattedTsDbVersion,
    };
  },
});
