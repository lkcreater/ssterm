import type { IpcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { MetadataRepository, StoreResult, WorkspaceTemplate } from '@ssterm/domain';
import {
  channels, failure, copyWorkspaceTemplateConfiguration, isWorkspaceTemplatesRequest, isSaveWorkspaceTemplateRequest,
  isDeleteWorkspaceTemplateRequest, type Result, type WorkspaceTemplateView,
} from '@ssterm/contracts';
import type { WindowBoundary } from './boundary';

export const workspaceTemplateChannels = Object.freeze([channels.workspaceTemplates, channels.saveWorkspaceTemplate, channels.deleteWorkspaceTemplate]);
const project = (row: WorkspaceTemplate): WorkspaceTemplateView => ({
  id: row.id, revision: row.revision, label: row.label, configuration: copyWorkspaceTemplateConfiguration(row.configuration),
});
const storeFailure = (stored: Exclude<StoreResult<unknown>, { ok: true }>) => failure(
  stored.error.code === 'conflict' ? 'conflict' : stored.error.code === 'constraint' || stored.error.code === 'invalid-request'
    ? 'invalid-request' : stored.error.code === 'busy' ? 'busy' : 'unavailable',
);
/** Configuration metadata only. Owner/app-lock authorization precedes validation and any repository access. */
export function registerWorkspaceTemplateHandlers(options: {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  boundary: WindowBoundary;
  repository: () => MetadataRepository | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (v: unknown) => v is T, run: (repository: MetadataRepository, request: T) => Result<unknown>) => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === 'object' && 'owner' in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure('invalid-request');
        const repository = options.repository();
        return repository ? run(repository, request) : failure('unavailable');
      } catch { return failure('unavailable'); }
    });
  };
  handle(channels.workspaceTemplates, isWorkspaceTemplatesRequest, repository => {
    const current = repository.snapshot();
    return current.ok ? { ok: true, value: { templates: current.value.workspaceTemplates.map(project).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)) } } : storeFailure(current);
  });
  handle(channels.saveWorkspaceTemplate, isSaveWorkspaceTemplateRequest, (repository, request) => {
    const current = repository.snapshot();
    if (!current.ok) return storeFailure(current);
    const id = request.templateId ?? randomUUID();
    const data = { label: request.label.trim(), configuration: copyWorkspaceTemplateConfiguration(request.configuration) };
    const stored = repository.commit({ expectedCatalogRevision: current.value.catalogRevision, changes: [request.templateId === null
      ? { type: 'create-workspace-template', id, data }
      : { type: 'update-workspace-template', id, expectedRevision: request.expectedRevision!, data }] });
    if (!stored.ok) return storeFailure(stored);
    const row = stored.value.workspaceTemplates.find(row => row.id === id);
    return row ? { ok: true, value: project(row) } : failure('unavailable');
  });
  handle(channels.deleteWorkspaceTemplate, isDeleteWorkspaceTemplateRequest, (repository, request) => {
    const current = repository.snapshot();
    if (!current.ok) return storeFailure(current);
    const stored = repository.commit({ expectedCatalogRevision: current.value.catalogRevision,
      changes: [{ type: 'delete-workspace-template', id: request.templateId, expectedRevision: request.expectedRevision }] });
    return stored.ok ? { ok: true, value: { deleted: true } } : storeFailure(stored);
  });
  return () => { for (const channel of workspaceTemplateChannels) options.ipc.removeHandler(channel); };
}
