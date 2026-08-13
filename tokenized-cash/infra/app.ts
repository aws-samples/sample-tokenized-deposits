#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { TokenizedCashStack } from "./stack";

const app = new cdk.App();

new TokenizedCashStack(app, "TokenizedCashPilot", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
});

// Run the cdk-nag AWS Solutions ruleset at synth time.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
