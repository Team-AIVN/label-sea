import { useCallback, useEffect, useMemo, useState } from "react";
import { DragDropContext, Draggable, Droppable } from "react-beautiful-dnd";
import { useTranslation } from "react-i18next";
import { useToast } from "@humansignal/ui";
import { useAPI } from "../../providers/ApiProvider";
import { cn } from "../../utils/bem";
import "./WorkerAssignment.prefix.css";

// Left pool droppable id + the three role zones a member can be dropped into.
// "member" is the no-work-role bucket (labeled "Worker"); reviewers/labelers are
// the real work roles. A member's zone IS their stored ProjectMember.role.
const POOL = "members";
const ROLE_ZONES = [
  { id: "member", key: "assign.workers", label: "Worker" },
  { id: "annotator", key: "assign.annotators", label: "Labelers" },
  { id: "reviewer", key: "assign.reviewers", label: "Reviewers" },
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
 * Drag-and-drop worker assignment for project creation. Workspace members sit in
 * the left pool; drag a member into Worker / Labelers / Reviewers to assign that
 * role, between boxes to switch role, or back to the pool to unassign. Dropping in
 * "Worker" stores the no-work-role `member` state. Changes persist immediately.
 */
export const WorkerAssignment = ({ projectId, workspaceId, show = true }) => {
  const { t } = useTranslation();
  const api = useAPI();
  const toast = useToast();
  const root = useMemo(() => cn("worker-assign"), []);

  const [members, setMembers] = useState([]); // workspace members (left pool)
  const [projectMembers, setProjectMembers] = useState([]); // assigned (right)
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  const loadMembers = useCallback(async () => {
    // Pool is every org member (assigning also grants workspace membership on the
    // backend). Resolve the org via the workspace, then normalize the shape.
    const workspace = await api.callApi("workspace", { params: { pk: workspaceId } });
    const orgId = workspace?.organization;
    const org = orgId ? await api.callApi("memberships", { params: { pk: orgId } }) : [];
    setMembers(listOf(org).map((m) => ({ user: m.user?.id ?? m.user, user_detail: m.user_detail ?? m.user })));
  }, [api, workspaceId]);

  const loadProjectMembers = useCallback(async () => {
    const pm = await api.callApi("projectMembers", { params: { pk: projectId } });
    setProjectMembers(listOf(pm));
  }, [api, projectId]);

  // Persist the chosen workspace onto the draft project first, so workspace-manager
  // authority resolves (membership management requires it) before we load/mutate.
  useEffect(() => {
    if (!show || !projectId || !workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      await api.callApi("updateProject", { params: { pk: projectId }, body: { workspace: workspaceId } });
      if (cancelled) return;
      await Promise.all([loadMembers(), loadProjectMembers()]);
      if (cancelled) return;
      setLoading(false);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [show, projectId, workspaceId, api, loadMembers, loadProjectMembers]);

  // Assigned = project members holding an assignment role (member/annotator/reviewer).
  const assigned = useMemo(() => projectMembers.filter((m) => ROLE_IDS.has(m.role)), [projectMembers]);
  const byRole = useMemo(() => {
    const map = { member: [], annotator: [], reviewer: [] };
    for (const m of assigned) map[m.role]?.push(m);
    return map;
  }, [assigned]);
  const roleByUser = useMemo(() => {
    const map = new Map();
    for (const m of assigned) map.set(m.user, m.role);
    return map;
  }, [assigned]);
  // Every active membership, including roles without a box here (e.g. project manager):
  // POST rejects users already on the project, so dropping them into a box changes the role.
  const memberIdByUser = useMemo(() => {
    const map = new Map();
    for (const m of projectMembers) map.set(m.user, m.id);
    return map;
  }, [projectMembers]);
  const assignedUserIds = useMemo(() => new Set(assigned.map((m) => m.user)), [assigned]);

  // Left pool = workspace members not yet assigned (respecting search).
  const poolMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => !assignedUserIds.has(m.user))
      .filter((m) => !q || userLabel(m.user_detail).toLowerCase().includes(q));
  }, [members, assignedUserIds, search]);

  const onDragEnd = useCallback(
    async (result) => {
      const { destination, draggableId } = result;
      if (!destination) return;
      const uid = Number(draggableId);
      const zone = destination.droppableId;

      if (ROLE_IDS.has(zone)) {
        if (roleByUser.get(uid) === zone) return; // dropped back in same box
        const memberPk = memberIdByUser.get(uid);
        // Already on the project: change the role. Otherwise add them.
        const res = memberPk
          ? await api.callApi("updateProjectMember", {
              params: { pk: projectId, memberPk },
              body: { role: zone },
              errorFilter: () => true,
            })
          : await api.callApi("createProjectMember", {
              params: { pk: projectId },
              body: { user: uid, role: zone },
              errorFilter: () => true,
            });
        if (!res?.$meta?.ok) {
          toast.show({ message: t("assign.actionFailed", "Could not update assignment"), type: "error" });
        } else {
          toast.show({ message: t("assign.added", "Workers assigned") });
        }
        await loadProjectMembers();
      } else if (zone === POOL) {
        if (!roleByUser.has(uid)) return; // wasn't in a role box
        const memberPk = memberIdByUser.get(uid);
        const res = await api.callApi("deleteProjectMember", {
          params: { pk: projectId, memberPk },
          errorFilter: () => true,
        });
        if (!res?.$meta?.ok) {
          toast.show({ message: t("assign.actionFailed", "Could not update assignment"), type: "error" });
        } else {
          toast.show({ message: t("assign.removed", "Workers removed") });
        }
        await loadProjectMembers();
      }
    },
    [api, projectId, roleByUser, memberIdByUser, toast, t, loadProjectMembers],
  );

  if (!show) return null;
  if (loading || !ready) return <div className={root.elem("loading").toClassName()}>…</div>;

  const renderCard = (uid, detail, index) => (
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
          <span className={root.elem("item-text").toClassName()}>{userLabel(detail)}</span>
        </li>
      )}
    </Draggable>
  );

  const renderRoleZone = (zone) => {
    const rows = byRole[zone.id] ?? [];
    return (
      <section key={zone.id} className={root.elem("box").toClassName()}>
        <header className={root.elem("box-head").toClassName()}>
          <strong>
            {t(zone.key, zone.label)}
            <span className={root.elem("count").toClassName()}>({rows.length})</span>
          </strong>
        </header>
        <Droppable droppableId={zone.id}>
          {(provided, snapshot) => (
            <ul
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={root
                .elem("items")
                .mod({ over: snapshot.isDraggingOver })
                .toClassName()}
            >
              {rows.map((m, i) => renderCard(m.user, m.user_detail, i))}
              {provided.placeholder}
              {rows.length === 0 && (
                <li className={root.elem("muted").toClassName()}>{t("assign.dragHere", "여기로 드래그")}</li>
              )}
            </ul>
          )}
        </Droppable>
      </section>
    );
  };

  return (
    <div className={cn("project-name").toClassName()}>
      <DragDropContext onDragEnd={onDragEnd}>
        <div className={root.mod({ dnd: true, triple: true }).toClassName()}>
          {/* LEFT: workspace members */}
          <section className={root.elem("panel").toClassName()}>
            <header className={root.elem("panel-head").toClassName()}>
              <strong>
                {t("assign.workspaceMembers", "Workspace members")}
                <span className={root.elem("count").toClassName()}>({poolMembers.length})</span>
              </strong>
              <input
                placeholder={t("assign.search", "Search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </header>
            <Droppable droppableId={POOL}>
              {(provided, snapshot) => (
                <ul
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={root
                    .elem("items")
                    .mod({ over: snapshot.isDraggingOver })
                    .toClassName()}
                >
                  {poolMembers.map((m, i) => renderCard(m.user, m.user_detail, i))}
                  {provided.placeholder}
                  {poolMembers.length === 0 && (
                    <li className={root.elem("muted").toClassName()}>{t("assign.noMembers", "No members")}</li>
                  )}
                </ul>
              )}
            </Droppable>
          </section>

          {/* RIGHT: three role zones */}
          <div className={root.elem("roles").toClassName()}>{ROLE_ZONES.map(renderRoleZone)}</div>
        </div>
      </DragDropContext>
    </div>
  );
};
