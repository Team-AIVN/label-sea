import type React from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { shallowEqualObjects } from "shallow-equal";
import { addVisitedProject } from "@humansignal/core";
import { useAuth } from "@humansignal/core/providers/AuthProvider";
import { FF_UNSAVED_CHANGES, isFF } from "../utils/feature-flags";
import { useAPI, type WrappedResponse } from "./ApiProvider";
import { useAppStore } from "./AppStoreProvider";
import { useFixedLocation, useParams } from "./RoutesProvider";
import { atom, useSetAtom } from "jotai";

type Empty = Record<string, never>;

export const projectAtom = atom<APIProject | Empty>({});

type Context = {
  project: APIProject | Empty;
  fetchProject: (id?: string | number, force?: boolean) => Promise<APIProject | void>;
  updateProject: (fields: APIProject) => Promise<WrappedResponse<APIProject>>;
  invalidateCache: () => void;
};

export const ProjectContext = createContext<Context>({} as Context);
ProjectContext.displayName = "ProjectContext";

const projectCache = new Map<number, APIProject>();

type UpdateProjectOptions = {
  returnErrors?: boolean;
};

export const ProjectProvider: React.FunctionComponent = ({ children }) => {
  const api = useAPI();
  const params = useParams();
  const location = useFixedLocation();
  const { user } = useAuth();
  const { update: updateStore } = useAppStore();
  // @todo use null for missed project data
  const [projectData, _setProjectData] = useState<APIProject | Empty>(projectCache.get(+params.id) ?? {});
  const setProject = useSetAtom(projectAtom);

  const setProjectData = (project: APIProject | Empty) => {
    _setProjectData(project);
    setProject(project);
  };

  const fetchProject: Context["fetchProject"] = useCallback(
    async (id, force = false) => {
      const finalProjectId = +(id ?? params.id);

      if (isNaN(finalProjectId)) return;

      if (!force && projectCache.has(finalProjectId) && projectCache.get(finalProjectId) !== undefined) {
        setProjectData({ ...projectCache.get(finalProjectId)! });
      }

      const result = await api.callApi<APIProject>("project", {
        params: { pk: finalProjectId },
        errorFilter: () => false,
      });

      const projectInfo = result as unknown as APIProject;

      // callApi resolves to null when the request fails (e.g. 404 for a project the
      // user may not see). The global error handler has already reported it.
      if (!projectInfo) return;

      if (shallowEqualObjects(projectData, projectInfo) === false) {
        setProjectData(projectInfo);
        updateStore({ project: projectInfo });
        projectCache.set(projectInfo.id, projectInfo);
      }

      if (projectInfo?.id) {
        addVisitedProject(projectInfo.id, user?.id);
      }

      return projectInfo;
    },
    [params],
  );

  const updateProject: Context["updateProject"] = useCallback(
    async (fields: APIProject, options?: UpdateProjectOptions) => {
      const result = await api.callApi<APIProject>("updateProject", {
        params: {
          pk: projectData.id,
        },
        body: fields,
        errorFilter: options?.returnErrors ? undefined : () => true,
      });

      if (isFF(FF_UNSAVED_CHANGES)) {
        if (result?.$meta?.ok) {
          setProjectData(result as unknown as APIProject);
          updateStore({ project: result });
          projectCache.set(result.id, result);
        }
      } else {
        if (result.$meta) {
          setProjectData(result as unknown as APIProject);
          updateStore({ project: result });
        }
      }

      return result;
    },
    [projectData, setProjectData, updateStore],
  );

  useEffect(() => {
    // Only resolve a project on project-scoped routes. The router exposes an `:id`
    // param for other sections too (e.g. /workspaces/:id); fetching /api/projects/<id>
    // there 404s and surfaces a spurious "No project matches the given query" toast.
    if (!/^\/projects\/\d+/.test(location?.pathname ?? "")) return;
    if (+params.id !== projectData?.id) {
      setProjectData({});
    }
    fetchProject();
  }, [params, location]);

  useEffect(() => {
    return () => projectCache.clear();
  }, []);

  return (
    <ProjectContext.Provider
      value={{
        project: projectData,
        fetchProject,
        updateProject,
        invalidateCache() {
          projectCache.clear();
          setProjectData({});
        },
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

// without this extra typing VSCode doesn't see the type after import :(
export const useProject: () => Context = () => {
  return useContext(ProjectContext) ?? {};
};
