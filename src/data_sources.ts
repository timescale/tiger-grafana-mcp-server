// Grafana config that varies by deploy environment, selected by PROD_DEPLOY.
// UIDs are Grafana-instance-specific; the public URL is the browser-facing
// host used to build deep links into Grafana.

const isProdDeploy =
  (process.env.PROD_DEPLOY ?? '').trim().toLowerCase() === 'true';

let dataSources: { prometheusThanosUid: string; postgresUid: string };
let publicUrl: string;

if (isProdDeploy) {
  dataSources = {
    prometheusThanosUid: 'P7C88DFFA3330979B',
    postgresUid: 'PDD8BC545CD76D0F3',
  };
  publicUrl = 'https://grafana.prod-us-east-1.ops.forge.timescale.com';
} else {
  dataSources = {
    prometheusThanosUid: 'P7C88DFFA3330979B',
    postgresUid: 'PDD8BC545CD76D0F3',
  };
  publicUrl = 'https://grafana.dev-us-east-1.ops.dev.timescale.com';
}

export const DATA_SOURCES = dataSources;
export const GRAFANA_PUBLIC_URL = publicUrl;
