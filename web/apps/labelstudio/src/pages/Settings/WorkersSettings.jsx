import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DragDropContext, Draggable, Droppable } from "react-beautiful-dnd";
import { Button, useToast } from "@humansignal/ui";
import { ProjectContext } from "../../providers/ProjectProvider";
import { useAPI } from "../../providers/ApiProvider";
import { projectPermissions } from "../../utils/permissions";
import { cn } from "../../utils/bem";
import "../CreateProject/WorkerAssignment.prefix.css";

// Left pool droppable id + the three role zones. "member" is the no-work-role
// bucket (labeled "Worker"). A card's zone IS its staged ProjectMember.role.
const POOL = "members";
const ROLE_ZONES = [
  { id: "member", label: "Worker" },
  { id: "annotator", label: "Labelers" },
  { id: "reviewer", label: "Reviewers" },
];
const ROLE_IDS = new Set(ROLE_ZONES.map((z) => z.id));

const listOf = (response) => {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.results)) return response.results;
  return [];
};

const userLabel = (detail) => {
  if (!detail) return "—";
  const name = `${detail.first_name ?? ""} ${detail.last_name ?? ""}`.trim();
  return name || detail.username || detail.email || `User ${detail.id}`;
};

/**
 * Project Settings → Workers: drag-and-drop worker assignment. Workspace members
 * live in the left pool; drag a member into Worker / Labelers / Reviewers to assign,
 * between boxes to switch role, or back to the pool to unassign. "Worker" is the
 * no-work-role `member` state. Changes are staged locally and applied on Save.
 */
export const WorkersSettings = () => {
  const { project } = useContext(ProjectContext);
  const api = useAPI();
  const toast = useToast();
  const root = useMemo(() => cn("worker-assign"), []);

  const projectId = project?.id;
  // Only workspace managers / super admins may invite a PM into the project; a plain PM
  // viewing this screen sees the worker roles only (backend enforces the same rule).
  const canAssignPM = projectPermissions(project?.current_user_role).canAssignManagers;

  const [members, setMembers] = useState([]); // this project's workers (assignable pool)
  const [userInfo, setUserInfo] = useState({}); // user_id -> user_detail
  const [serverByUser, setServerByUser] = useState({}); // user_id -> { memberId, role } (saved state)
  const [assignments, setAssignments] = useState({}); // user_id -> role (desired/staged)
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [inviteRole, setInviteRole] = useState("annotator");
  const [inviteLink, setInviteLink] = useState("");
  const [inviting, setInviting] = useState(false);

  const generateInvite = useCallback(async () => {
    setInviting(true);
    const res = await api.callApi("createInvitation", { body: { project: projectId, role: inviteRole } });
    setInviting(false);
    if (res?.link) {
      setInviteLink(res.link);
      toast.show({ message: "초대 링크가 생성됐습니다" });
    } else {
      toast.show({ message: res?.detail ?? "초대 생성에 실패했습니다", type: "error" });
    }
  }, [api, projectId, inviteRole, toast]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    const pm = await api.callApi("projectMembers", { params: { pk: projectId } });
    const projMembers = listOf(pm);
    // Pool + boxes show only this project's workers (member/annotator/reviewer).
    // Project managers and non-project users are excluded. New workers are brought
    // in via the invite link above.
    const workers = projMembers.filter((m) => ROLE_IDS.has(m.role));

    const info = {};
    for (const m of projMembers) info[m.user] = m.user_detail;

    const server = {};
    const desired = {};
    for (const m of workers) {
      server[m.user] = { memberId: m.id, role: m.role };
      desired[m.user] = m.role;
    }

    setMembers(workers.map((m) => ({ user: m.user, user_detail: m.user_detail })));
    setUserInfo(info);
    setServerByUser(server);
    setAssignments(desired);
    setLoading(false);
  }, [api, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Derive per-zone user lists from the staged assignments.
  const byRole = useMemo(() => {
    const map = { member: [], annotator: [], reviewer: [] };
    for (const [uid, role] of Object.entries(assignments)) map[role]?.push(Number(uid));
    return map;
  }, [assignments]);
  const assignedUserIds = useMemo(() => new Set(Object.keys(assignments).map(Number)), [assignments]);

  // Left pool = workspace members not assigned to any role (respecting search).
  const poolMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => !assignedUserIds.has(m.user))
      .filter((m) => !q || userLabel(m.user_detail).toLowerCase().includes(q));
  }, [members, assignedUserIds, search]);

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(serverByUser), ...Object.keys(assignments)]);
    for (const k of keys) {
      if ((serverByUser[k]?.role ?? null) !== (assignments[k] ?? null)) return true;
    }
    return false;
  }, [serverByUser, assignments]);

  const onDragEnd = useCallback((result) => {
    const { destination, draggableId } = result;
    if (!destination) return;
    const uid = Number(draggableId);
    const zone = destination.droppableId;
    setAssignments((prev) => {
      const next = { ...prev };
      if (zone === POOL) delete next[uid];
      else if (ROLE_IDS.has(zone)) next[uid] = zone;
      return next;
    });
  }, []);

  const onSave = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    const ops = [];
    // Removals + role changes against the saved state.
    for (const [uidStr, srv] of Object.entries(serverByUser)) {
      const uid = Number(uidStr);
      const desiredRole = assignments[uid];
      if (!desiredRole) {
        ops.push(
          api.callApi("deleteProjectMember", {
            params: { pk: projectId, memberPk: srv.memberId },
            errorFilter: () => true,
          }),
        );
      } else if (desiredRole !== srv.role) {
        ops.push(
          api.callApi("updateProjectMember", {
            params: { pk: projectId, memberPk: srv.memberId },
            body: { role: desiredRole },
            errorFilter: () => true,
          }),
        );
      }
    }
    // Additions.
    for (const [uidStr, role] of Object.entries(assignments)) {
      const uid = Number(uidStr);
      if (!serverByUser[uid]) {
        ops.push(
          api.callApi("createProjectMember", {
            params: { pk: projectId },
            body: { user: uid, role },
            errorFilter: () => true,
          }),
        );
      }
    }
    const results = await Promise.all(ops);
    setSaving(false);
    if (results.some((r) => !r?.$meta?.ok)) {
      toast.show({ message: "Could not save some changes", type: "error" });
    } else {
      toast.show({ message: "Workers updated" });
    }
    await load();
  }, [api, projectId, dirty, serverByUser, assignments, toast, load]);

  const onCancel = useCallback(() => {
    const desired = {};
    for (const [uid, srv] of Object.entries(serverByUser)) desired[uid] = srv.role;
    setAssignments(desired);
  }, [serverByUser]);

  const renderCard = (uid, index) => (
    <Draggable key={uid} draggableId={String(uid)} index={index}>
      {(provided, snapshot) => (
        <li
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={root
            .elem("card")
            .mod({ dragging: snapshot.isDragging })
            .toClassName()}
        >
          <span className={root.elem("grip").toClassName()} aria-hidden>
            ⠿
          </span>
          <span className={root.elem("item-text").toClassName()}>{userLabel(userInfo[uid])}</span>
        </li>
      )}
    </Draggable>
  );

  const renderZone = (zoneId, title, uids, { head } = {}) => (
    <section className={root.elem(zoneId === POOL ? "panel" : "box").toClassName()}>
      {head ?? (
        <header className={root.elem("box-head").toClassName()}>
          <strong>
            {title}
            <span className={root.elem("count").toClassName()}>({uids.length})</span>
          </strong>
        </header>
      )}
      <Droppable droppableId={zoneId}>
        {(provided, snapshot) => (
          <ul
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={root
              .elem("items")
              .mod({ over: snapshot.isDraggingOver })
              .toClassName()}
          >
            {uids.map((uid, i) => renderCard(uid, i))}
            {provided.placeholder}
            {uids.length === 0 && <li className={root.elem("muted").toClassName()}>{"여기로 드래그"}</li>}
          </ul>
        )}
      </Droppable>
    </section>
  );

  const poolHead = (
    <header className={root.elem("panel-head").toClassName()}>
      <strong>
        멤버
        <span className={root.elem("count").toClassName()}>({poolMembers.length})</span>
      </strong>
      <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
    </header>
  );

  return (
    <div className={cn("general-settings").toClassName()}>
      <div className={cn("general-settings").elem("wrapper").toClassName()}>
        <h1>Workers</h1>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>작업자 초대 (계정이 없는 사람)</div>
          <div style={{ fontSize: 13, color: "var(--color-neutral-content-subtler)", marginBottom: 8 }}>
            초대 링크를 만들어 전달하세요. 상대가 그 링크로 가입하면 이 프로젝트의 작업자로 자동 배치됩니다. (자동 이메일
            발송이 아닙니다)
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              style={{ height: 32, padding: "0 8px", border: "1px solid var(--color-neutral-border)", borderRadius: 6 }}
            >
              <option value="member">Worker (미배정)</option>
              <option value="annotator">라벨러</option>
              <option value="reviewer">검수자</option>
              {canAssignPM && <option value="project_manager">PM (프로젝트 관리자)</option>}
            </select>
            <Button size="small" onClick={generateInvite} waiting={inviting}>
              초대 링크 생성
            </Button>
          </div>
          {inviteLink && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, maxWidth: 720 }}>
              <input
                readOnly
                value={inviteLink}
                onFocus={(e) => e.target.select()}
                style={{
                  flex: 1,
                  height: 32,
                  padding: "0 8px",
                  border: "1px solid var(--color-neutral-border)",
                  borderRadius: 6,
                }}
              />
              <Button
                size="small"
                look="outlined"
                onClick={() => {
                  navigator.clipboard?.writeText(inviteLink);
                  toast.show({ message: "복사됐습니다" });
                }}
              >
                링크 복사
              </Button>
            </div>
          )}
        </div>

        <p className={root.elem("hint").toClassName()}>
          이 프로젝트의 작업자를 <b>Worker</b>, <b>Labelers</b>, <b>Reviewers</b> 중 하나로 끌어다 배치하세요.
          <br />
          상자 사이로 끌면 역할이 바뀌고, 왼쪽으로 끌면 프로젝트에서 제외됩니다.
        </p>
        <div className={cn("settings-wrapper").toClassName()}>
          {loading ? (
            <div className={root.elem("loading").toClassName()}>…</div>
          ) : (
            <>
              <DragDropContext onDragEnd={onDragEnd}>
                <div className={root.mod({ dnd: true, triple: true }).toClassName()}>
                  {/* LEFT: unassigned workspace members */}
                  {renderZone(POOL, "멤버", poolMembers.map((m) => m.user), { head: poolHead })}

                  {/* RIGHT: three role zones */}
                  <div className={root.elem("roles").toClassName()}>
                    {ROLE_ZONES.map((z) => (
                      <div key={z.id}>{renderZone(z.id, z.label, byRole[z.id] ?? [])}</div>
                    ))}
                  </div>
                </div>
              </DragDropContext>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <Button
                  look="outlined"
                  onClick={onCancel}
                  disabled={!dirty || saving}
                  aria-label="Cancel worker changes"
                >
                  Cancel
                </Button>
                <Button onClick={onSave} waiting={saving} disabled={!dirty} aria-label="Save worker changes">
                  Save
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

WorkersSettings.menuItem = "Workers";
WorkersSettings.path = "/workers";
WorkersSettings.exact = true;
