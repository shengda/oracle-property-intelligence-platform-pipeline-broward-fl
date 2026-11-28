import { App, Stack, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { expect, test } from "vitest";
import { OracleStack, PROJECT_TAG } from "../../infra/lib/oracle-stack.ts";

function synth(alarmEmail?: string) {
  const app = new App();
  const images = new Stack(app, "Images", { env: { account: "111111111111", region: "us-east-2" } });
  const stack = new OracleStack(app, "OracleBroward", {
    env: { account: "111111111111", region: "us-east-2" },
    manifestCid: "bafkreitest",
    image: lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(images, "Repo", "oracle")),
    anthropicKeyParam: "/roofing/anthropic-key",
    agentModel: "claude-sonnet-5-5",
    agentDailyTokens: 500_000,
    agentPerIpPerMinute: 6,
    memoryMb: 3008,
    monthlyBudgetUsd: 5,
    alarmEmail,
  });
  Tags.of(app).add("project_name", PROJECT_TAG);
  return { stack, t: Template.fromStack(stack) };
}

test("stack: region us-east-2, every taggable resource tagged project_name", () => {
  const { stack, t } = synth("ops@example.com");
  expect(stack.region).toBe("us-east-2");
  const tagged = ["AWS::Lambda::Function", "AWS::DynamoDB::Table", "AWS::SNS::Topic", "AWS::Events::Rule"];
  for (const type of tagged) {
    for (const r of Object.values(t.findResources(type))) {
      const tags = (r as any).Properties.Tags ?? (r as any).Properties.TagSpecifications;
      const list = Array.isArray(tags)
        ? tags
        : Object.entries(tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
      expect(list, type).toContainEqual({ Key: "project_name", Value: PROJECT_TAG });
    }
  }
});

test("stack: one container Lambda on a public Function URL (auth NONE), warm ping every 5 minutes", () => {
  const { t } = synth();
  t.resourceCountIs("AWS::Lambda::Function", 1);
  t.hasResourceProperties("AWS::Lambda::Function", {
    PackageType: "Image",
    MemorySize: 3008,
    Timeout: 60,
    Environment: {
      Variables: Match.objectLike({
        ORACLE_MANIFEST_CID: "bafkreitest",
        ORACLE_AGENT_MODEL: "claude-sonnet-5-5",
        ORACLE_AGENT_DAILY_TOKENS: "500000",
      }),
    },
  });
  t.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  t.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
  t.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });
});

test("stack: the Claude key comes from an SSM parameter, never a plain env value", () => {
  const { t } = synth();
  const fn = Object.values(t.findResources("AWS::Lambda::Function"))[0] as any;
  const vars = fn.Properties.Environment.Variables;
  expect(vars.ANTHROPIC_API_KEY).toBeUndefined();
  expect(vars.ANTHROPIC_KEY_PARAM).toBe("/roofing/anthropic-key");
  const statements = Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement,
  );
  const ssm = statements.find((s: any) => s.Action === "ssm:GetParameter");
  expect(JSON.stringify(ssm.Resource)).toContain(":parameter/roofing/anthropic-key");
});

test("stack: error, 5xx and agent-budget alarms notify SNS email; monthly budget alarm exists", () => {
  const { t } = synth("ops@example.com");
  t.resourceCountIs("AWS::CloudWatch::Alarm", 3);
  t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Errors", Threshold: 1 });
  t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Url5xxCount" });
  t.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "AgentTokens",
    Namespace: "OracleBroward",
    Threshold: 400_000,
    Period: 86_400,
  });
  t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
  t.hasResourceProperties("AWS::Budgets::Budget", {
    Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: "USD" }, TimeUnit: "MONTHLY" }),
  });
});

test("stack: without an alarm email there is no subscription and the budget has no subscribers", () => {
  const { t } = synth();
  t.resourceCountIs("AWS::SNS::Subscription", 0);
  const b = Object.values(t.findResources("AWS::Budgets::Budget"))[0] as any;
  expect(b.Properties.NotificationsWithSubscribers).toBeUndefined();
});
