# Hosted Oracle (AWS, CDK)

**Live:** https://jbahdp5wn5czd3bj2trxjjz6ha0tfyzg.lambda-url.us-east-2.on.aws/
(MCP: `…/mcp`, health: `…/api/health`). Public and read-only.

One container Lambda (`us-east-2`, tagged `project_name=oracle-broward`) on a public HTTPS
Function URL serves the Explorer UI, the HTTP API v1, `/mcp` and the agent from the published run
baked into the image. See `docs/DECISIONS.md` § M5 for why it is built this way.

| Piece | What |
|---|---|
| `Dockerfile` | Node 22 + AWS Lambda Web Adapter; `src/hosted.ts` bundled with esbuild; UI build; DuckDB `fts`/`vss` extensions and the embedding model installed at build time; `cache/published/<cid>/` copied in |
| `infra/` | CDK app (`OracleBroward` stack): the Lambda + Function URL, DynamoDB table for the agent's daily budget, 5-minute warm ping, alarms to SNS email, monthly AWS Budgets alarm |
| `deploy/hosted.json` | Settings (no secrets): manifest CID, agent model, budgets, memory |
| `.github/workflows/uptime.yml` | Pings `/api/health` every 30 minutes and checks the manifest CID |

## One-time setup

1. AWS credentials for the account, default region `us-east-2`; `npx cdk bootstrap` once.
2. The Claude key in SSM, typed into a hidden prompt (never committed, never on a command line):
   ```sh
   read -s "K?Anthropic key: " && aws ssm put-parameter --region us-east-2 \
     --name /roofing/anthropic-key --type SecureString --overwrite --value "$K"; unset K
   ```
3. Activate `project_name` as a cost allocation tag (Billing → Cost allocation tags) so the
   monthly budget, which filters on it, sees the stack's cost.

## Deploy, or redeploy on a new manifest

```sh
npm run oracle -- sync --manifest <cid>      # fetch + verify every file into cache/published/<cid>/
# set "manifestCid" in deploy/hosted.json
cd infra && npx cdk deploy -c alarmEmail=<address>
```

The image is rebuilt with the new run; the health page then shows the new manifest CID. After the
first deploy, confirm the SNS subscription email, or no alarm reaches you.

Old images accumulate in the CDK assets ECR repository (~1.8 GB each, $0.10/GB-month); delete
untagged ones after a redeploy.

## Check it

```sh
U=https://jbahdp5wn5czd3bj2trxjjz6ha0tfyzg.lambda-url.us-east-2.on.aws
curl -s $U/api/health
curl -s -X POST $U/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Measured (first deploy)

| | |
|---|---|
| Memory setting / used | 3008 MB / ~265 MB |
| Cold start | ~10 s init, 13 s first request |
| Warm requests | health ~0.3 s; aged-roofs radius query ~1.7 s first, faster after |
| Agent (Sonnet 5.5) | one-tool question in 3.6 s, ~12k tokens |
| Image | 1.76 GB |

## Cost (estimate, list prices)

Idle: about $1/month (ECR image storage ~$0.20, three alarms $0.30, logs). Lambda, DynamoDB and
the warm ping stay inside the free tier at demo traffic. The agent is billed by Anthropic:
about $0.05–0.10 per question on Sonnet 5.5, capped at 500k tokens a day (~$2/day worst case).

## Fallback

If AWS hosting were unavailable, the same image runs anywhere that accepts a container listening
on `PORT` (for example a Hugging Face Docker Space); that would be a recorded kit deviation.
