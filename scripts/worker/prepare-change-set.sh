#!/usr/bin/env bash
# Manual OIDC job only. No SQS attribute changes, migration, or queue activation.
set -euo pipefail
for key in STAGE EXPECTED_ACCOUNT PRODUCTION_ACCOUNT AWS_REGION SOURCE_ARN DLQ_ARN MAIL_BUCKET DB_SECRET APP_SECRET SUBNETS SECURITY_GROUP ARTIFACT_BUCKET CFN_ROLE GITHUB_SHA; do [[ -n ${!key:-} ]] || { echo "Missing $key" >&2; exit 1; }; done
[[ $GITHUB_SHA =~ ^[0-9a-f]{40}$ && $(git rev-parse HEAD) == "$GITHUB_SHA" ]]
[[ $EXPECTED_ACCOUNT =~ ^[0-9]{12}$ && $PRODUCTION_ACCOUNT =~ ^[0-9]{12}$ ]]
[[ $(aws sts get-caller-identity --query Account --output text) == "$EXPECTED_ACCOUNT" ]]
case "$STAGE" in
  production) [[ $EXPECTED_ACCOUNT == "$PRODUCTION_ACCOUNT" ]] || exit 1;;
  isolated) [[ $EXPECTED_ACCOUNT != "$PRODUCTION_ACCOUNT" ]] || exit 1;;
  *) exit 1;;
esac
[[ $SOURCE_ARN != "$DLQ_ARN" && $DB_SECRET != "$APP_SECRET" && $ARTIFACT_BUCKET != "$MAIL_BUCKET" ]]
for arn in "$SOURCE_ARN" "$DLQ_ARN"; do [[ $arn == arn:aws:sqs:"$AWS_REGION":"$EXPECTED_ACCOUNT":* && $arn != *.fifo ]] || exit 1; done
for arn in "$DB_SECRET" "$APP_SECRET"; do [[ $arn == arn:aws:secretsmanager:"$AWS_REGION":"$EXPECTED_ACCOUNT":secret:* ]] || exit 1; done
[[ $CFN_ROLE == arn:aws:iam::"$EXPECTED_ACCOUNT":role/* ]]
aws s3api head-bucket --bucket "$MAIL_BUCKET" --expected-bucket-owner "$EXPECTED_ACCOUNT"
aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" --expected-bucket-owner "$EXPECTED_ACCOUNT"
queue_attributes() {
  local url
  url=$(aws sqs get-queue-url --queue-name "${1##*:}" --queue-owner-aws-account-id "$EXPECTED_ACCOUNT" --query QueueUrl --output text)
  aws sqs get-queue-attributes --queue-url "$url" --attribute-names All --query Attributes --output json
}
source_attributes=$(queue_attributes "$SOURCE_ARN"); dlq_attributes=$(queue_attributes "$DLQ_ARN")
jq -e --arg arn "$SOURCE_ARN" --arg dlq "$DLQ_ARN" \
  '.QueueArn == $arn and (.VisibilityTimeout|tonumber) >= 270 and (.RedrivePolicy|fromjson | .deadLetterTargetArn == $dlq and (.maxReceiveCount|tonumber) >= 3 and (.maxReceiveCount|tonumber) <= 5)' <<<"$source_attributes" >/dev/null
source_retention=$(jq '.MessageRetentionPeriod|tonumber' <<<"$source_attributes")
jq -e --arg arn "$DLQ_ARN" --argjson source "$source_retention" '.QueueArn == $arn and (.MessageRetentionPeriod|tonumber) > $source' <<<"$dlq_attributes" >/dev/null
name="mailhub-worker-$STAGE"
alias_arn="arn:aws:lambda:$AWS_REGION:$EXPECTED_ACCOUNT:function:$name:live"
# An enabled mapping is permitted ONLY after the separate cutover owner attests PM2 is stopped.
aws lambda list-event-source-mappings --event-source-arn "$SOURCE_ARN" --output json | jq -e --arg alias "$alias_arn" --arg owner "${CONSUMER_OWNER:-unverified}" 'all(.EventSourceMappings[]; .State == "Disabled" or (.State == "Enabled" and .FunctionArn == $alias and $owner == "lambda-exclusive")) and ([.EventSourceMappings[]|select(.State == "Enabled")]|length <= 1)' >/dev/null
case "${OPERATION:-preview}" in
  preview) operation=(--no-execute-changeset);;
  publish) [[ ${PUBLISH_GATE:-} == true ]] || exit 1; operation=(--no-confirm-changeset);;
  *) exit 1;;
esac
params=(Stage="$STAGE" WorkerName="$name" SourceQueueArn="$SOURCE_ARN" DeadLetterQueueArn="$DLQ_ARN" MailBucket="$MAIL_BUCKET" DatabaseSecretArn="$DB_SECRET" WorkerSecretArn="$APP_SECRET" PrivateSubnetIds="$SUBNETS" WorkerSecurityGroup="$SECURITY_GROUP")
[[ -z ${MAIL_PREFIX:-} ]] || params+=(MailPrefix="$MAIL_PREFIX")
[[ -z ${DECRYPT_KEYS:-} ]] || params+=(DecryptKeyArns="$DECRYPT_KEYS")
sam deploy --template-file infra/worker/template.yaml --stack-name "$name" \
  --s3-bucket "$ARTIFACT_BUCKET" --s3-prefix "worker/$STAGE/$GITHUB_SHA" --role-arn "$CFN_ROLE" \
  --region "$AWS_REGION" --capabilities CAPABILITY_IAM "${operation[@]}" --no-fail-on-empty-changeset \
  --parameter-overrides "${params[@]}"
