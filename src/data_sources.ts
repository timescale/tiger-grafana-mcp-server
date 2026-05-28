// Grafana datasource UIDs, selected by the PROD_DEPLOY env var.
// UIDs are Grafana-instance-specific, so dev and prod differ.

const isProdDeploy =
  (process.env.PROD_DEPLOY ?? '').trim().toLowerCase() === 'true';

let dataSources: { prometheusThanosUid: string; postgresUid: string };

if (isProdDeploy) {
  dataSources = {
    prometheusThanosUid: '',
    postgresUid: '',
  };
} else {
  dataSources = {
    prometheusThanosUid: 'P7C88DFFA3330979B',
    postgresUid: 'PDD8BC545CD76D0F3',
  };
}

export const DATA_SOURCES = dataSources;
