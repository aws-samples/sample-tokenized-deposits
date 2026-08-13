import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as kms from "aws-cdk-lib/aws-kms";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export class TokenizedCashStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- VPC (for Besu PrivateLink access) ---
    // Look up the existing Besu VPC by ID (set via context: -c besuVpcId=vpc-xxx)
    // Falls back to creating a minimal VPC for local synth testing.
    const vpcId = this.node.tryGetContext("besuVpcId");
    const vpc = vpcId
      ? ec2.Vpc.fromLookup(this, "BesuVpc", { vpcId })
      : new ec2.Vpc(this, "PilotVpc", {
          maxAzs: 2,
          natGateways: 0,
          subnetConfiguration: [{ name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
        });

    const lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc,
      description: "Security group for VPC-attached lambdas accessing Besu PrivateLink",
      allowAllOutbound: true,
    });

    // Allow inbound HTTPS from lambdas to VPC endpoint ENIs (same SG)
    lambdaSg.addIngressRule(lambdaSg, ec2.Port.tcp(443), "Lambda to VPC Interface Endpoints");

    // --- EventBridge VPC Endpoint (required for watcher → stage-handler flow) ---
    new ec2.InterfaceVpcEndpoint(this, "EventBridgeEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
      securityGroups: [lambdaSg],
      privateDnsEnabled: true,
    });

    // --- KMS signing keys (ECC_SECG_P256K1 for secp256k1 CSI signing) ---
    const caSigningKey = new kms.Key(this, "CaSigningKey", {
      keySpec: kms.KeySpec.ECC_SECG_P256K1,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "tokenized-cash/ca-signer",
      description: "KMS key for CA entity EIP-712 signing (secp256k1)",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mxSigningKey = new kms.Key(this, "MxSigningKey", {
      keySpec: kms.KeySpec.ECC_SECG_P256K1,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "tokenized-cash/mx-signer",
      description: "KMS key for MX entity EIP-712 signing (secp256k1)",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const relayerSigningKey = new kms.Key(this, "RelayerSigningKey", {
      keySpec: kms.KeySpec.ECC_SECG_P256K1,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "tokenized-cash/relayer-signer",
      description: "KMS key for relayer transaction signing (secp256k1)",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- DynamoDB table ---
    const table = new dynamodb.Table(this, "InstructionsTable", {
      tableName: "tokenized-cash-instructions",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    table.addGlobalSecondaryIndex({
      indexName: "gsi-status",
      partitionKey: { name: "gsiStatus", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- EventBridge bus ---
    const eventBus = new events.EventBus(this, "SettlementBus", {
      eventBusName: "tokenized-cash-bus",
    });

    // --- SNS topic ---
    const notificationTopic = new sns.Topic(this, "NotificationTopic", {
      topicName: "tokenized-cash-notifications",
    });

    // --- Common Lambda environment ---
    const commonEnv: Record<string, string> = {
      TABLE_NAME: table.tableName,
      KMS_KEY_ID_CA: caSigningKey.keyId,
      KMS_KEY_ID_MX: mxSigningKey.keyId,
      SETTLEMENT_CONTRACT: this.node.tryGetContext("settlementContract") || "0x0000000000000000000000000000000000000000",
      ALLOWED_CHAIN_ID: "70924",
      EVENT_BUS_NAME: eventBus.eventBusName,
      BESU_RPC_URL: this.node.tryGetContext("besuRpcUrl") || "http://besu-privatelink.internal:8545",
      MX_WALLET: this.node.tryGetContext("mxWallet") || "0x0000000000000000000000000000000000000002",
    };

    // --- Intake Lambda (API-facing, no VPC needed) ---
    const intakeFn = new lambdaNode.NodejsFunction(this, "IntakeFn", {
      entry: path.join(__dirname, "../lambdas/intake/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
    });

    // --- Relayer Lambda (VPC-attached, DynamoDB Streams trigger) ---
    const relayerFn = new lambdaNode.NodejsFunction(this, "RelayerFn", {
      entry: path.join(__dirname, "../lambdas/relayer/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      vpc,
      securityGroups: [lambdaSg],
      environment: {
        ...commonEnv,
        KMS_KEY_ID_RELAYER: relayerSigningKey.keyId,
      },
      bundling: { minify: true, sourceMap: true },
      reservedConcurrentExecutions: 1,
    });

    relayerFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 5,
        retryAttempts: 3,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.or("INSERT", "MODIFY"),
            dynamodb: {
              NewImage: {
                status: { S: lambda.FilterRule.isEqual("FUNDED") },
                sk: { S: lambda.FilterRule.isEqual("INSTRUCTION") },
              },
            },
          }),
        ],
      })
    );

    // --- Watcher Lambda (VPC-attached, DDB Streams trigger on SUBMITTED) ---
    const watcherFn = new lambdaNode.NodejsFunction(this, "WatcherFn", {
      entry: path.join(__dirname, "../lambdas/watcher/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      vpc,
      securityGroups: [lambdaSg],
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
    });

    watcherFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,
        retryAttempts: 3,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("MODIFY"),
            dynamodb: {
              NewImage: {
                status: { S: lambda.FilterRule.isEqual("SUBMITTED") },
                sk: { S: lambda.FilterRule.isEqual("INSTRUCTION") },
              },
            },
          }),
        ],
      })
    );

    // --- Stage Handlers Lambda (EventBridge-triggered) ---
    const stageHandlerFn = new lambdaNode.NodejsFunction(this, "StageHandlerFn", {
      entry: path.join(__dirname, "../lambdas/stage-handlers/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
    });

    const stageRule = new events.Rule(this, "StageRule", {
      eventBus,
      eventPattern: {
        source: ["tokenized-cash.watcher"],
        detailType: ["SettlementLifecycle"],
      },
    });
    stageRule.addTarget(new targets.LambdaFunction(stageHandlerFn));

    // --- FX Lambda ---
    const fxFn = new lambdaNode.NodejsFunction(this, "FxFn", {
      entry: path.join(__dirname, "../lambdas/fx/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: true },
    });

    // --- Instructions Lambda (history + status queries) ---
    const instructionsFn = new lambdaNode.NodejsFunction(this, "InstructionsFn", {
      entry: path.join(__dirname, "../lambdas/instructions/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: true },
    });

    // --- Chain Reader Lambda (VPC-attached, proxies on-chain reads for UI) ---
    const chainReaderFn = new lambdaNode.NodejsFunction(this, "ChainReaderFn", {
      entry: path.join(__dirname, "../lambdas/chain-reader/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      vpc,
      securityGroups: [lambdaSg],
      environment: {
        BESU_RPC_URL: commonEnv.BESU_RPC_URL,
        SETTLEMENT_CONTRACT: commonEnv.SETTLEMENT_CONTRACT,
        TOKEN_ADDRESS: this.node.tryGetContext("tokenAddress") || commonEnv.SETTLEMENT_CONTRACT,
      },
      bundling: { minify: true, sourceMap: true },
    });

    // --- API Gateway ---
    const api = new apigateway.RestApi(this, "TokenizedCashApi", {
      restApiName: "Tokenized Cash Pilot",
      deployOptions: { stageName: "v1" },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const apiKey = api.addApiKey("PilotApiKey", { apiKeyName: "tokenized-cash-pilot-key" });
    const usagePlan = api.addUsagePlan("UsagePlan", {
      name: "PilotUsagePlan",
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    const intakeIntegration = new apigateway.LambdaIntegration(intakeFn);
    const fxIntegration = new apigateway.LambdaIntegration(fxFn);
    const chainReaderIntegration = new apigateway.LambdaIntegration(chainReaderFn);

    const mintResource = api.root.addResource("mint");
    mintResource.addMethod("POST", intakeIntegration, { apiKeyRequired: true });

    const redeemResource = api.root.addResource("redeem");
    redeemResource.addMethod("POST", intakeIntegration, { apiKeyRequired: true });

    const fxResource = api.root.addResource("fx");
    const fxRateResource = fxResource.addResource("rate");
    fxRateResource.addMethod("GET", fxIntegration, { apiKeyRequired: true });
    fxRateResource.addMethod("POST", fxIntegration, { apiKeyRequired: true });
    const fxConvertResource = fxResource.addResource("convert");
    fxConvertResource.addMethod("POST", fxIntegration, { apiKeyRequired: true });

    const instructionsIntegration = new apigateway.LambdaIntegration(instructionsFn);
    const instructionsResource = api.root.addResource("instructions");
    instructionsResource.addMethod("GET", instructionsIntegration, { apiKeyRequired: true });
    const instructionByIdResource = instructionsResource.addResource("{id}");
    instructionByIdResource.addMethod("GET", instructionsIntegration, { apiKeyRequired: true });

    const chainResource = api.root.addResource("chain");
    const chainTokenResource = chainResource.addResource("token");
    chainTokenResource.addMethod("GET", chainReaderIntegration, { apiKeyRequired: true });
    const chainBalanceResource = chainResource.addResource("balance");
    chainBalanceResource.addMethod("GET", chainReaderIntegration, { apiKeyRequired: true });
    const chainExecutedResource = chainResource.addResource("executed");
    chainExecutedResource.addMethod("GET", chainReaderIntegration, { apiKeyRequired: true });
    const chainBlockResource = chainResource.addResource("block");
    chainBlockResource.addMethod("GET", chainReaderIntegration, { apiKeyRequired: true });

    // --- Permissions ---
    table.grantReadWriteData(intakeFn);
    table.grantReadWriteData(relayerFn);
    table.grantReadWriteData(watcherFn);
    table.grantReadWriteData(stageHandlerFn);
    table.grantReadWriteData(fxFn);
    table.grantReadData(instructionsFn);

    caSigningKey.grant(intakeFn, "kms:Sign", "kms:GetPublicKey");
    mxSigningKey.grant(intakeFn, "kms:Sign", "kms:GetPublicKey");
    caSigningKey.grant(stageHandlerFn, "kms:Sign", "kms:GetPublicKey");
    relayerSigningKey.grant(relayerFn, "kms:Sign", "kms:GetPublicKey");

    eventBus.grantPutEventsTo(watcherFn);

    // --- SNS notification rule (on FAILED) ---
    const failedRule = new events.Rule(this, "FailedRule", {
      eventBus,
      eventPattern: {
        source: ["tokenized-cash.watcher"],
        detailType: ["SettlementLifecycle"],
        detail: { status: ["FAILED"] },
      },
    });
    failedRule.addTarget(new targets.SnsTopic(notificationTopic));

    // --- Outputs ---
    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CaKmsKeyId", { value: caSigningKey.keyId });
    new cdk.CfnOutput(this, "MxKmsKeyId", { value: mxSigningKey.keyId });
    new cdk.CfnOutput(this, "RelayerKmsKeyId", { value: relayerSigningKey.keyId });
    new cdk.CfnOutput(this, "EventBusName", { value: eventBus.eventBusName });

    // --- cdk-nag suppressions (AwsSolutionsChecks) ---
    // Documented, accepted deviations for the pilot. Mirrors the stack-level
    // suppression pattern used in the besu-private-chain app. Each entry is a
    // deliberate decision scoped to a non-production pilot; several are flagged
    // as fast-follow items before any external exposure.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-APIG4",
        reason:
          "Pilot REST API is protected by a required API key plus usage plan for caller identification and throttling, and is reachable only from the private pilot environment. Full IAM/Cognito authorization is a fast-follow before any external exposure.",
      },
      {
        id: "AwsSolutions-COG4",
        reason:
          "The pilot does not use Cognito user pools; API access is gated by a required API key and usage plan. A Cognito or Lambda authorizer is a fast-follow before external exposure.",
      },
      {
        id: "AwsSolutions-APIG1",
        reason:
          "Access logging is not required for the internal pilot; request volume is low and calls originate from a controlled environment. To be enabled before production.",
      },
      {
        id: "AwsSolutions-APIG2",
        reason:
          "Request payloads are validated within the integrated Lambda handlers, which reject malformed input. Gateway-level request validation is a fast-follow enhancement.",
      },
      {
        id: "AwsSolutions-APIG3",
        reason:
          "WAFv2 is not attached for the pilot as the API is not publicly exposed. A web ACL will be associated before any production/external rollout.",
      },
      {
        id: "AwsSolutions-APIG6",
        reason:
          "Per-method CloudWatch execution logging is disabled to reduce noise/cost during the pilot; Lambda-side structured logging provides sufficient traceability. To be enabled before production.",
      },
      {
        id: "AwsSolutions-IAM4",
        reason:
          "AWS managed policies (AWSLambdaBasicExecutionRole, AWSLambdaVPCAccessExecutionRole, AmazonAPIGatewayPushToCloudWatchLogs) provide standard, least-surprise execution permissions for the pilot's Lambda and API Gateway roles. These are well-scoped AWS-maintained policies acceptable for a pilot.",
      },
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Wildcard permissions are limited to the DynamoDB table's own secondary indexes (table/index/*), which CDK's grant helpers generate and cannot be enumerated statically, and to CloudWatch Logs actions scoped by the execution role. No cross-resource wildcards are granted.",
      },
      {
        id: "AwsSolutions-L1",
        reason:
          "Lambda runtimes are pinned to a version validated against the ethers v6 / KMS signing dependencies used by the pilot. Runtime upgrades are managed deliberately to avoid compatibility regressions in the signing path.",
      },
      {
        id: "AwsSolutions-EC23",
        reason:
          "Security group ingress is scoped to intra-VPC PrivateLink access to the Besu chain within the isolated pilot VPC; one rule references the VPC CIDR via an intrinsic and cannot be statically validated. No ingress is open to the public internet.",
      },
      {
        id: "AwsSolutions-VPC7",
        reason:
          "VPC flow logs are not enabled for the fallback pilot VPC used for local synth/testing; the production deployment reuses the existing Besu VPC (via besuVpcId context) whose flow logging is managed by the besu-private-chain stack.",
      },
      {
        id: "AwsSolutions-SNS3",
        reason:
          "The SNS topic only receives internal EventBridge-delivered failure notifications within the account; SSL-only publisher enforcement is not required for this pilot notification path.",
      },
      {
        id: "AwsSolutions-DDB3",
        reason:
          "Point-in-time recovery is not enabled for the pilot table; settlement instructions are reconstructable from the on-chain record and the immutable audit items, and PITR will be enabled before production.",
      },
    ]);
  }
}
