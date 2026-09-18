#!/usr/bin/env bash
#
# 부트스트랩: 워크스페이스 2개를 만들고 WM1/WM2 를 workspace_manager 로 지정한다.
#
# 왜 API 가 아니라 Django shell 인가:
#   `POST /api/workspaces/` 는 can_create_workspace (= super admin 이거나 이미 어떤
#   워크스페이스의 workspace_manager) 를 요구한다(users/rules.py:146-177).
#   목 계정 WM1/WM2 는 아직 아무 워크스페이스의 매니저가 아니라서 최초 1회는
#   관리자 권한으로 만들어 줘야 한다. 이 단계 이후로는 WM1/WM2 가 API 로
#   워크스페이스를 더 만들 수 있다(TC-WS-005 가 그걸 검증한다).
#
# 전제: docker compose 로 app/db 가 떠 있고, 계정 11개가 이미 가입되어 있을 것.
#       (계정 생성은 seed/signup.sh)
#
# 사용법:  e2e/seed/bootstrap.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

docker compose exec -T -w /label-studio/label_studio app python manage.py shell -c '
from django.contrib.auth import get_user_model
from organizations.models import Organization
from workspaces.models import Workspace, WorkspaceMember

User = get_user_model()
org = Organization.objects.first()

PLAN = [
    ("[E2E] 워크스페이스 A", "E2E 목 데이터 — 텍스트 감성 분류 운영 조직", "localtest_wm1@test.com"),
    ("[E2E] 워크스페이스 B", "E2E 목 데이터 — 검수 파일럿 운영 조직", "localtest_wm2@test.com"),
]

for title, description, manager_email in PLAN:
    manager = User.objects.get(email=manager_email)
    ws, created = Workspace.objects.get_or_create(
        organization=org,
        title=title,
        defaults={"description": description, "created_by": manager},
    )
    if ws.deleted_at is not None:
        ws.deleted_at = None
        ws.save(update_fields=["deleted_at"])
    member, _ = WorkspaceMember.objects.get_or_create(
        workspace=ws, user=manager,
        defaults={"role": WorkspaceMember.Role.WORKSPACE_MANAGER},
    )
    if member.role != WorkspaceMember.Role.WORKSPACE_MANAGER or member.deleted_at is not None:
        member.role = WorkspaceMember.Role.WORKSPACE_MANAGER
        member.deleted_at = None
        member.save(update_fields=["role", "deleted_at"])
    # 매니저 외의 멤버는 정리한다. 프로젝트 멤버 배정이 워크스페이스 멤버를 자동으로
    # 추가하기 때문에, 이전 실행이 남긴 멤버십이 "비멤버" 접근 거부 테스트를 무너뜨린다.
    # (API DELETE 대신 하드 삭제를 쓰는 이유: soft delete 된 멤버를 다시 배정하면
    #  projects/members_api.py:138 의 deleted_by 저장 때문에 500 이 난다)
    removed, _ = WorkspaceMember.objects.filter(workspace=ws).exclude(
        role=WorkspaceMember.Role.WORKSPACE_MANAGER
    ).delete()

    status = "생성" if created else "확인"
    print(status, ws.id, ws.title, "manager=" + manager_email, "정리된 멤버=" + str(removed))
'
