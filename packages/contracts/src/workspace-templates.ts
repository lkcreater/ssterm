import { exactObject, isCounter, isOwner, type Owner } from './index.ts';
import { isCatalogId, validateCatalogLabel } from './catalog.ts';
import { isWorkspaceTemplateConfiguration, MAX_WORKSPACE_TEMPLATES, type WorkspaceTemplateConfiguration, type WorkspaceTemplateView } from '@ssterm/domain/workspace-templates';
export * from '@ssterm/domain/workspace-templates';
export interface WorkspaceTemplatesRequest { owner: Owner }
export interface WorkspaceTemplatesResponse { templates: WorkspaceTemplateView[] }
export interface SaveWorkspaceTemplateRequest {
  owner: Owner;
  templateId: string | null;
  expectedRevision: number | null;
  label: string;
  configuration: WorkspaceTemplateConfiguration;
}
export interface DeleteWorkspaceTemplateRequest { owner: Owner; templateId: string; expectedRevision: number }
export interface DeleteWorkspaceTemplateResponse { deleted: true }
const positive = (v: unknown): v is number => isCounter(v) && v > 0;
export function isWorkspaceTemplatesRequest(v: unknown): v is WorkspaceTemplatesRequest {
  return exactObject(v, ['owner']) && isOwner(v.owner);
}
export function isWorkspaceTemplateView(v: unknown): v is WorkspaceTemplateView {
  return exactObject(v, ['id', 'revision', 'label', 'configuration']) && isCatalogId(v.id) && positive(v.revision) &&
    typeof v.label === 'string' && v.label.length <= 2048 && validateCatalogLabel(v.label) === null && isWorkspaceTemplateConfiguration(v.configuration);
}
export function isWorkspaceTemplatesResponse(v: unknown): v is WorkspaceTemplatesResponse {
  return exactObject(v, ['templates']) && Array.isArray(v.templates) && v.templates.length <= MAX_WORKSPACE_TEMPLATES &&
    v.templates.every(isWorkspaceTemplateView) && new Set(v.templates.map(t => t.id)).size === v.templates.length;
}
export function isSaveWorkspaceTemplateRequest(v: unknown): v is SaveWorkspaceTemplateRequest {
  return exactObject(v, ['owner', 'templateId', 'expectedRevision', 'label', 'configuration']) && isOwner(v.owner) &&
    ((v.templateId === null && v.expectedRevision === null) || (isCatalogId(v.templateId) && positive(v.expectedRevision))) &&
    typeof v.label === 'string' && v.label.length <= 2048 && validateCatalogLabel(v.label) === null && isWorkspaceTemplateConfiguration(v.configuration);
}
export function isDeleteWorkspaceTemplateRequest(v: unknown): v is DeleteWorkspaceTemplateRequest {
  return exactObject(v, ['owner', 'templateId', 'expectedRevision']) && isOwner(v.owner) && isCatalogId(v.templateId) && positive(v.expectedRevision);
}
export function isDeleteWorkspaceTemplateResponse(v: unknown): v is DeleteWorkspaceTemplateResponse {
  return exactObject(v, ['deleted']) && v.deleted === true;
}
