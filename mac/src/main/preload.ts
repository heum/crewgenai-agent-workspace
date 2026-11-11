// renderer에 최소 API만 노출한다. Node·파일 시스템 직접 접근은 주지 않는다.
import { contextBridge, ipcRenderer } from 'electron';
import type { LiveEvent, WorkspaceApi } from '../shared/types';

const methods = [
  'listProjects', 'createProject', 'updatePlan', 'planHistory', 'pickFolder', 'pickFiles', 'pickSubfolder',
  'revealInFinder', 'openPath', 'previewFile', 'readTextFile',
  'listAgents', 'saveAgent', 'duplicateAgent', 'setAgentActive', 'loadAgentTemplates', 'agentTemplateSets',
  'latestGraph', 'listGraphVersions', 'validateGraph', 'saveGraph', 'defaultGraph',
  'startRun', 'rerunFrom', 'pauseRun', 'resumeRun', 'cancelRun', 'resolveInterrupted', 'listRuns', 'runDetail', 'attemptEvents',
  'submitReview', 'cliStatus', 'pickCliPath', 'openLoginTerminal', 'getSettings', 'saveSettings', 'helpDocs',
  'codexStatus', 'listMissions', 'missionReadiness', 'startMission', 'missionDetail', 'answerMission', 'addDirective', 'missionSnapshots', 'rollbackMission', 'listPromptTemplates', 'projectDocs', 'saveProjectDocs', 'reviewProjectDoc', 'resetProjectDocs', 'uploadProjectDoc', 'stopMission', 'retryMissionLimit', 'workingNow',
] as const;

const api: Record<string, unknown> = {};
for (const m of methods) api[m] = (...args: unknown[]) => ipcRenderer.invoke(`ws:${m}`, ...args);
api.onLive = (cb: (e: LiveEvent) => void) => {
  const h = (_: unknown, e: LiveEvent) => cb(e);
  ipcRenderer.on('ws:live', h);
  return () => ipcRenderer.removeListener('ws:live', h);
};
contextBridge.exposeInMainWorld('workspace', api as unknown as WorkspaceApi);
export const IPC_METHODS = methods;
