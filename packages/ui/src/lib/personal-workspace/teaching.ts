import { z } from 'zod';
import { invokeDesktop, isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';

const teachingState = z.object({ phase: z.enum(['ready', 'recording', 'review']), recordingId: z.string().nullable(), seconds: z.number().nonnegative(), viewUrl: z.string().url(), videoUrl: z.string().url().nullable(), recordings: z.array(z.string()) }).refine((state) => !state.videoUrl || new URL(state.videoUrl).origin === new URL(state.viewUrl).origin);
export type TeachingState = z.infer<typeof teachingState>;
export const teachingSupported = () => isElectronShell() && isDesktopLocalOriginActive();
export async function dismissTeaching() {
  if (!teachingSupported()) return;
  z.object({ closed: z.literal(true) }).parse(await invokeDesktop('desktop_personal_teaching', { action: 'dismiss' }));
}
export async function controlTeaching(action: 'status' | 'start' | 'stop' | 'review', id?: string): Promise<TeachingState> {
  if (!teachingSupported()) throw new Error('teaching_unsupported');
  return teachingState.parse(await invokeDesktop('desktop_personal_teaching', id ? { action, id } : { action }));
}

const skillModel = z.object({ id: z.string(), providerID: z.string(), name: z.string() });
const skillDraft = z.object({ source: z.string(), name: z.string(), markdown: z.string(), installed: z.boolean() });
export type TeachingSkillDraft = z.infer<typeof skillDraft>;
export type TeachingSkillModel = z.infer<typeof skillModel>;
const skillInvoke = async (input: { action: string; source?: string; name?: string; markdown?: string; notes?: string; task?: string; directory?: string; model?: { id: string; providerID: string }; approved?: true }) => {
  if (!teachingSupported()) throw new Error('teaching_unsupported');
  return invokeDesktop('desktop_teaching_skill', input);
};
export const teachingSkillModels = async () => z.array(skillModel).parse(await skillInvoke({ action: 'models' }));
const editKey = (source: string) => `open-carter:teaching-edit:v1:${source}`;
const inputsSchema = z.object({ notes: z.string().max(6000), task: z.string().max(6000) });
export const readTeachingInputs = (source: string) => inputsSchema.parse(JSON.parse(localStorage.getItem(`${editKey(source)}:inputs`) ?? '{"notes":"","task":""}'));
export const cacheTeachingInputs = (source: string, inputs: z.infer<typeof inputsSchema>) => localStorage.setItem(`${editKey(source)}:inputs`, JSON.stringify(inputsSchema.parse(inputs)));
export const cacheTeachingSkillDraft = (draft: TeachingSkillDraft) => localStorage.setItem(editKey(draft.source), JSON.stringify(skillDraft.parse(draft)));
export const readTeachingSkill = async (source: string) => {
  const saved = z.object({ draft: skillDraft.nullable() }).parse(await skillInvoke({ action: 'draft', source })).draft;
  const raw = localStorage.getItem(editKey(source));
  if (!raw) return saved;
  const edit = skillDraft.parse(JSON.parse(raw));
  if (edit.source !== source) throw new Error('teaching_invalid_draft');
  return saved?.name === edit.name && saved.markdown === edit.markdown ? saved : { ...edit, installed: false };
};
export const saveTeachingSkillDraft = async (draft: TeachingSkillDraft) => skillDraft.parse(await skillInvoke({ action: 'saveDraft', source: draft.source, name: draft.name, markdown: draft.markdown }));
export const compileTeachingSkill = async (source: string, notes: string, model: TeachingSkillModel) => skillDraft.parse(await skillInvoke({ action: 'compile', source, notes, model: { id: model.id, providerID: model.providerID }, approved: true }));
export const installTeachingSkill = async (draft: TeachingSkillDraft) => z.object({ name: z.string(), markdown: z.string() }).parse(await skillInvoke({ action: 'install', source: draft.source, name: draft.name, markdown: draft.markdown, approved: true }));
export const testTeachingSkill = async (source: string, task: string, directory: string, model: TeachingSkillModel) => z.object({ sessionId: z.string(), directory: z.string() }).parse(await skillInvoke({ action: 'test', source, task, directory, model: { id: model.id, providerID: model.providerID }, approved: true }));
