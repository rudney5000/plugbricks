#!/bin/sh
# Provision task for the "object-storage" capability: one bucket, one user and one key per consumer, through the
# S3 port (the S3 API and the IAM API SeaweedFS serves on it). Idempotent: it creates what is missing, sets the
# policy again, replaces any other key of the user, and never deletes a bucket or an object.
#
# Inputs (from plugin.json provides.object-storage.provision.env):
#   S3_ENDPOINT, ADMIN_ACCESS_KEY, ADMIN_SECRET_KEY   the server and its administrator
#   APP_NAME                                          consumer name: its bucket and its user
#   APP_ACCESS_KEY, APP_SECRET_KEY                    consumer key
set -eu

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${ADMIN_ACCESS_KEY:?ADMIN_ACCESS_KEY is required}"
: "${ADMIN_SECRET_KEY:?ADMIN_SECRET_KEY is required}"
: "${APP_NAME:?APP_NAME is required}"
: "${APP_ACCESS_KEY:?APP_ACCESS_KEY is required}"
: "${APP_SECRET_KEY:?APP_SECRET_KEY is required}"

body=$(mktemp)
trap 'rm -f "$body"' EXIT

# One signed request; prints the HTTP status and leaves the answer in $body. The credentials are given to curl on
# its standard input (-K -), so that no key is on a command line. Keys are letters and digits (secrets.ts).
#   signed <access key> <secret key> <s3|iam> <curl arguments...>
signed() {
  key=$1 secret=$2 service=$3
  shift 3
  printf 'user = "%s:%s"\n' "$key" "$secret" |
    curl -sS -K - -o "$body" -w '%{http_code}' --aws-sigv4 "aws:amz:us-east-1:$service" \
      -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' "$@"
}
s3() { signed "$ADMIN_ACCESS_KEY" "$ADMIN_SECRET_KEY" s3 "$@"; }
iam() { signed "$ADMIN_ACCESS_KEY" "$ADMIN_SECRET_KEY" iam "$S3_ENDPOINT/" --data-urlencode Version=2010-05-08 "$@"; }
code() { sed -n 's/.*<Code>\([^<]*\)<.*/\1/p' "$body" | head -n 1; }
fail() {
  echo "create-bucket: $1 failed: HTTP $2 $(code)" >&2
  exit 1
}

tries=0
until curl -fsS -m 2 -o /dev/null "$S3_ENDPOINT/healthz"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "create-bucket: $S3_ENDPOINT not ready after 30 attempts" >&2
    exit 1
  fi
  sleep 1
done

# Looked for first: the owner of a bucket is the name of the administrator that made it, which changes with the
# administrator's key, so creating it again would be refused.
status=$(s3 -I "$S3_ENDPOINT/$APP_NAME")
if [ "$status" = 404 ]; then
  status=$(s3 -X PUT "$S3_ENDPOINT/$APP_NAME")
fi
[ "$status" = 200 ] || fail "creating bucket \"$APP_NAME\"" "$status"

status=$(iam --data-urlencode Action=CreateUser --data-urlencode "UserName=$APP_NAME")
[ "$status" = 200 ] || [ "$(code)" = EntityAlreadyExists ] || fail "creating user \"$APP_NAME\"" "$status"

# Read, write, list and delete objects of this bucket, and nothing else: not the bucket's policy or ACL (which could
# open it to anyone), not its deletion, no other bucket.
bucket="arn:aws:s3:::$APP_NAME"
policy='{"Version":"2012-10-17","Statement":[
{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads"],"Resource":["'"$bucket"'"]},
{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:GetObjectTagging","s3:PutObjectTagging","s3:DeleteObjectTagging","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["'"$bucket"'/*"]}]}'
status=$(iam --data-urlencode Action=PutUserPolicy --data-urlencode "UserName=$APP_NAME" \
  --data-urlencode PolicyName=bucket --data-urlencode "PolicyDocument=$policy")
[ "$status" = 200 ] || fail "setting the policy of \"$APP_NAME\"" "$status"

works() {
  [ "$(signed "$APP_ACCESS_KEY" "$APP_SECRET_KEY" s3 "$S3_ENDPOINT/$APP_NAME?list-type=2&max-keys=0")" = 200 ]
}

# A key the user holds and plugbricks no longer knows (a secret generated again) must stop working.
status=$(iam --data-urlencode Action=ListAccessKeys --data-urlencode "UserName=$APP_NAME")
[ "$status" = 200 ] || fail "listing the keys of \"$APP_NAME\"" "$status"
keys=$(grep -o '<AccessKeyId>[^<]*' "$body" | cut -d'>' -f2 || true)
present=no
for k in $keys; do
  if [ "$k" = "$APP_ACCESS_KEY" ] && works; then
    present=yes
    continue
  fi
  status=$(iam --data-urlencode Action=DeleteAccessKey --data-urlencode "UserName=$APP_NAME" --data-urlencode "AccessKeyId=$k")
  [ "$status" = 200 ] || fail "deleting an old key of \"$APP_NAME\"" "$status"
done

if [ "$present" = no ]; then
  # Sent on the standard input as well: the secret of the new key is not on a command line either.
  status=$(printf 'data-urlencode = "SecretAccessKey=%s"\ndata-urlencode = "AccessKeyId=%s"\nuser = "%s:%s"\n' \
    "$APP_SECRET_KEY" "$APP_ACCESS_KEY" "$ADMIN_ACCESS_KEY" "$ADMIN_SECRET_KEY" |
    curl -sS -K - -o "$body" -w '%{http_code}' --aws-sigv4 aws:amz:us-east-1:iam "$S3_ENDPOINT/" \
      --data-urlencode Version=2010-05-08 --data-urlencode Action=CreateAccessKey --data-urlencode "UserName=$APP_NAME")
  [ "$status" = 200 ] || fail "creating the key of \"$APP_NAME\"" "$status"
fi

# The server takes a moment to know a new key: the consumer starts only once its key answers.
tries=0
until works; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "create-bucket: the key of \"$APP_NAME\" is not accepted after 30 attempts" >&2
    exit 1
  fi
  sleep 1
done

echo "create-bucket: bucket \"$APP_NAME\" and its key ready"
