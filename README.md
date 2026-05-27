# Tiger Grafana MCP Server

MCP server that queries Timescale Grafana datasources (Postgres and Prometheus) to return information about user instances.

Built on [`@tigerdata/mcp-boilerplate`](https://www.npmjs.com/package/@tigerdata/mcp-boilerplate) and the [Model Context Protocol](https://modelcontextprotocol.io/introduction).

## Tools

| Tool | Description |
|------|-------------|
| `user_instance_basic_information` | Returns PostgreSQL and TimescaleDB versions for a given `projectId` and `serviceId`, plus a deep link (`dashboardUrl`) to the **user-instance-single** Grafana dashboard. |

## Requirements

- Node.js 22+
- A Grafana URL reachable from where the server runs
- A Grafana **service account token** with permission to query datasources

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `GRAFANA_URL` | yes | Grafana API base URL (no trailing slash). In-cluster: `http://monitoring-v2-grafana.savannah-system.svc.cluster.local` |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | yes | Grafana service account token (Bearer auth) |
| `PROD_DEPLOY` | no | When `true`, deep links target the prod Grafana host. Anything else (or unset) targets dev. Used only for user-facing URLs, not for API queries. |

Create a `.env` file in the project root:

```bash
GRAFANA_URL=http://monitoring-v2-grafana.savannah-system.svc.cluster.local
GRAFANA_SERVICE_ACCOUNT_TOKEN=your-token-here
```

### Grafana service account token

1. Open Grafana (dev: `https://grafana.dev-us-east-1.ops.dev.timescale.com` or your environment URL).
2. **Administration** → **Service accounts** → create or select an account.
3. Add a token with access to the Postgres and Prometheus datasources used by the tool.
4. Put the token in `GRAFANA_SERVICE_ACCOUNT_TOKEN`.

For Kubernetes deploys, the token is stored as a sealed secret in [`tiger-agents-deploy`](../tiger-agents-deploy) under `charts/tiger-grafana-mcp-server/values/dev.yaml`.

## Development

```bash
git clone git@github.com:timescale/tiger-grafana-mcp-server.git
cd tiger-grafana-mcp-server
npm install
npm run build
```

### One-command local dev (recommended)

The repo ships a script that installs deps, builds, opens a `kubectl` tunnel to the in-cluster dev Grafana, starts the MCP server on HTTP, and launches the MCP Inspector pointed at it.

```bash
./scripts/dev-inspector.sh
```

Prerequisites:
- `.env` exists with `GRAFANA_SERVICE_ACCOUNT_TOKEN` set
- `kubectl` configured against the dev cluster (e.g. `kubectx ts-dev@us-east-1`)
- Node.js 22+

The script overrides `GRAFANA_URL` to the local tunnel (`http://localhost:3000`) for the duration of the run, and tears the tunnel + MCP server down on exit.

### Run manually

**HTTP** (default for Docker):

```bash
npm run build
node dist/index.js http
```

**stdio** (for Claude Desktop / Inspector):

```bash
node dist/index.js stdio
```

### Scripts

| Command | Description |
|---------|-------------|
| `./scripts/dev-inspector.sh` | One-command local dev: tunnel + MCP server + Inspector |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type check only |
| `npm run test` | Run tests |
| `npm run lint` | Biome lint |
| `npm run inspector` | Open MCP Inspector |

### MCP Inspector (manual)

```bash
npm run build
npx @modelcontextprotocol/inspector
```

| Field | Value |
|-------|-------|
| Transport | `STDIO` |
| Command | `node` |
| Arguments | `dist/index.js` |

Set `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the inspector env section (or use `.env` with stdio after loading dotenv via your shell).

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "tiger-grafana": {
      "command": "node",
      "args": ["/absolute/path/to/tiger-grafana-mcp-server/dist/index.js", "stdio"],
      "env": {
        "GRAFANA_URL": "http://monitoring-v2-grafana.savannah-system.svc.cluster.local",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Deployment

Images are built and deployed via GitHub Actions, which dispatch workflows in [tiger-agents-deploy](https://github.com/timescale/tiger-agents-deploy).

| Event | Behavior |
|-------|----------|
| Push to a feature branch | Build image (`latest` + `auto-<sha>`), deploy to **dev** (`savannah-system`). No Slack notification. |
| Push to `main` | Build image (`latest` + `auto-<sha>`), deploy to **dev**. Prod deploy is wired in the workflow but currently disabled until prod secrets/config are ready. |

Helm chart: `tiger-agents-deploy/charts/tiger-grafana-mcp-server`

When prod deploys are enabled, set `PROD_DEPLOY=true` in the prod chart values so the deep links resolve to `https://grafana.prod-us-east-1.ops.forge.timescale.com` instead of the dev host.

**Dev Tailscale URL** (when Tailscale is enabled in dev values):

`https://tiger-grafana-mcp-server.tail9d164.ts.net`

## License

Apache-2.0
