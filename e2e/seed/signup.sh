#!/usr/bin/env bash
#
# 목 계정 12개를 /user/signup/ 폼으로 가입시킨다 (이미 있으면 그냥 실패 메시지가 뜨고 넘어감).
# 화면에서 가입하는 것과 같은 뷰·같은 검증을 거친다.
#
# 역할 → 이메일 규칙: localtest_{역할}@test.com
#   한글은 이메일 로컬파트에 쓸 수 없어 작업자→annotator, 검수자→reviewer 로 표기한다.
#
# 사용법:  e2e/seed/signup.sh [BASE_URL]
set -euo pipefail

BASE="${1:-${LS_BASE_URL:-http://localhost:8080}}"
PASSWORD="test1234"

signup() {
  local email="$1" name="$2"
  local jar; jar="$(mktemp)"
  curl -s -c "$jar" "$BASE/user/signup/" -o /dev/null
  local csrf; csrf="$(awk '/csrftoken/ {print $7}' "$jar")"
  local code
  code="$(curl -s -b "$jar" -c "$jar" -o /dev/null -w '%{http_code}' \
    -H "Referer: $BASE/user/signup/" \
    -d "csrfmiddlewaretoken=$csrf" \
    --data-urlencode "email=$email" \
    --data-urlencode "name=$name" \
    -d "password=$PASSWORD" \
    -d "next=/projects/" \
    "$BASE/user/signup/")"
  # 302 = 가입 성공 후 리다이렉트, 200 = 폼 오류(대개 "이미 존재하는 이메일")
  if [ "$code" = "302" ]; then echo "가입 완료  $email ($name)"; else echo "건너뜀/실패 $email ($name) HTTP $code"; fi
  rm -f "$jar"
}

# admin 을 먼저 가입시킨다 — 빈 DB 라면 이 계정이 조직 소유자(슈퍼 관리자)가 된다.
signup localtest_admin@test.com "관리자"
signup localtest_annotator1@test.com "작업자1"
signup localtest_annotator2@test.com "작업자2"
signup localtest_annotator3@test.com "작업자3"
signup localtest_reviewer1@test.com "검수자1"
signup localtest_reviewer2@test.com "검수자2"
signup localtest_pm1@test.com "PM1"
signup localtest_pm2@test.com "PM2"
signup localtest_pm3@test.com "PM3"
signup localtest_pm4@test.com "PM4"
signup localtest_wm1@test.com "WM1"
signup localtest_wm2@test.com "WM2"
