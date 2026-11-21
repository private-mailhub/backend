#!/usr/bin/env bash
# Trusted deployment job only. All build/tests have already finished without AWS access.
set -euo pipefail
: "${DEPLOY_BUCKET:?}" "${CODEDEPLOY_APP:?}" "${CODEDEPLOY_GROUP:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
[[ $# == 1 && -s $1 && $GITHUB_SHA =~ ^[a-f0-9]{40}$ && $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ ]] || exit 2
[[ $(aws s3api get-bucket-versioning --bucket "$DEPLOY_BUCKET" --query Status --output text) == Enabled ]] || { echo 'artifact bucket must have active versioning' >&2; exit 1; }
key="api/$GITHUB_SHA/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.zip"
version=$(aws s3api put-object --bucket "$DEPLOY_BUCKET" --key "$key" --body "$1" --if-none-match '*' --query VersionId --output text)
[[ -n $version && $version != None && $version != null ]] || { echo 'missing S3 object version' >&2; exit 1; }
revision=$(jq -nc --arg b "$DEPLOY_BUCKET" --arg k "$key" --arg v "$version" '{revisionType:"S3",s3Location:{bucket:$b,key:$k,bundleType:"zip",version:$v}}')
deployment=$(aws deploy create-deployment --application-name "$CODEDEPLOY_APP" --deployment-group-name "$CODEDEPLOY_GROUP" --revision "$revision" --description "API $GITHUB_SHA / workflow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --query deploymentId --output text)
[[ $deployment =~ ^d-[[:alnum:]]+$ ]] || { echo 'no deployment ID' >&2; exit 1; }
printf 'Waiting for API deployment %s\n' "$deployment"
aws deploy wait deployment-successful --deployment-id "$deployment"
