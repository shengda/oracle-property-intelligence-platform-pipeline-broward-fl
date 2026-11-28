import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export const PROJECT_TAG = "oracle-broward";
/** Matches src/hosted.ts: Powertools Metrics namespace and its `service` dimension. */
export const METRICS_NAMESPACE = "OracleBroward";
export const METRICS_SERVICE = "oracle-broward";

export interface OracleStackProps extends StackProps {
  /** The published run baked into the image (also shown on the health page). */
  manifestCid: string;
  /** Container image: the repo Dockerfile in deploys, a stand-in in tests. */
  image: lambda.DockerImageCode;
  /** SSM SecureString holding the Claude key (created by hand, never in code). */
  anthropicKeyParam: string;
  agentModel: string;
  agentDailyTokens: number;
  agentPerIpPerMinute: number;
  memoryMb: number;
  monthlyBudgetUsd: number;
  /** Alarm and budget notifications; passed at deploy time (`-c alarmEmail=…`), never committed. */
  alarmEmail?: string;
}

/**
 * Hosted Oracle: one container Lambda (Explorer UI, HTTP API v1, /mcp, agent) on a public HTTPS
 * Function URL, a DynamoDB table for the agent's shared daily budget, a 5-minute warm ping,
 * error / 5xx / agent-budget alarms to SNS email, and a monthly AWS Budgets alarm.
 */
export class OracleStack extends Stack {
  readonly url: string;

  constructor(scope: Construct, id: string, props: OracleStackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "AgentBudget", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Only short-lived counters live here.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.DockerImageFunction(this, "Oracle", {
      code: props.image,
      architecture: lambda.Architecture.X86_64,
      memorySize: props.memoryMb,
      timeout: Duration.seconds(60),
      // Caps cost and DuckDB load under a burst; far above what a demo or grader needs.
      reservedConcurrentExecutions: 20,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ORACLE_MANIFEST_CID: props.manifestCid,
        ORACLE_AGENT_MODEL: props.agentModel,
        ORACLE_AGENT_DAILY_TOKENS: String(props.agentDailyTokens),
        ORACLE_AGENT_PER_IP_PER_MINUTE: String(props.agentPerIpPerMinute),
        // The Lambda stops at 60 s; the agent gives up first and says so.
        ORACLE_AGENT_TIMEOUT_MS: "50000",
        ORACLE_BUDGET_TABLE: table.tableName,
        ANTHROPIC_KEY_PARAM: props.anthropicKeyParam,
        POWERTOOLS_SERVICE_NAME: METRICS_SERVICE,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      },
    });
    table.grantReadWriteData(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: props.anthropicKeyParam.replace(/^\//, ""),
          }),
        ],
      }),
    );

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    this.url = fnUrl.url;

    // Keep one instance warm so a grader's first request does not pay the cold start.
    new events.Rule(this, "WarmPing", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 0 })],
    });

    const topic = new sns.Topic(this, "Alarms", { displayName: "Oracle Broward alarms" });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const notify = new actions.SnsAction(topic);

    const errors = new cloudwatch.Alarm(this, "ErrorsAlarm", {
      alarmDescription: "The hosted Oracle Lambda reported errors (crash, timeout or failed start).",
      metric: fn.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const url5xx = new cloudwatch.Alarm(this, "Url5xxAlarm", {
      alarmDescription: "The hosted Oracle returned 5xx responses on its Function URL.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Url5xxCount",
        dimensionsMap: { FunctionName: fn.functionName },
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const agentBudget = new cloudwatch.Alarm(this, "AgentBudgetAlarm", {
      alarmDescription: `The agent used 80% of its daily token budget (${props.agentDailyTokens}).`,
      metric: new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: "AgentTokens",
        dimensionsMap: { service: METRICS_SERVICE },
        period: Duration.days(1),
        statistic: "Sum",
      }),
      threshold: Math.round(props.agentDailyTokens * 0.8),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const a of [errors, url5xx, agentBudget]) a.addAlarmAction(notify);

    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `${PROJECT_TAG}-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        // Needs `project_name` activated as a cost allocation tag (deploy/README.md).
        costFilters: { TagKeyValue: [`user:project_name$${PROJECT_TAG}`] },
      },
      notificationsWithSubscribers: props.alarmEmail
        ? [
            {
              notification: {
                notificationType: "ACTUAL",
                comparisonOperator: "GREATER_THAN",
                threshold: 80,
                thresholdType: "PERCENTAGE",
              },
              subscribers: [{ subscriptionType: "EMAIL", address: props.alarmEmail }],
            },
            {
              notification: {
                notificationType: "FORECASTED",
                comparisonOperator: "GREATER_THAN",
                threshold: 100,
                thresholdType: "PERCENTAGE",
              },
              subscribers: [{ subscriptionType: "EMAIL", address: props.alarmEmail }],
            },
          ]
        : undefined,
    });

    new CfnOutput(this, "OracleUrl", { value: fnUrl.url, description: "Explorer UI and HTTP API" });
    new CfnOutput(this, "McpUrl", { value: `${fnUrl.url}mcp`, description: "MCP (Streamable HTTP)" });
    new CfnOutput(this, "HealthUrl", { value: `${fnUrl.url}api/health` });
  }
}
