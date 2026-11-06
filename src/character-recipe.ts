import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { VERSION } from './version.js';
import { constructionSchema } from './character-construction.js';
import { planCharacterBuild, planCharacterBuildSchema } from './character-build.js';
import { filename, label, request, sha, pin, verifyPins, verifySource, jsonRead, immutableJson, operation } from './character-candidates.js';

export const saveCharacterRecipeSchema = z.object({
  ...request, name: label, plan: filename, expectedSha256: sha
}).strict();
export const planCharacterRecipeSchema = z.object({
  input: filename, name: label, recipe: filename, expectedSha256: sha,
  confirmation: z.literal('recheck_landmarks_for_current_character'),
  psd: constructionSchema.shape.psd,
  overrides: z.object({
    preparation: constructionSchema.shape.preparation.unwrap().optional(),
    controls: constructionSchema.shape.controls.unwrap().optional(),
    motions: constructionSchema.shape.motions.unwrap().optional(),
    templates: constructionSchema.shape.templates.unwrap().optional()
  }).strict().default({}),
  publication: planCharacterBuildSchema.shape.publication,
  reviewMedia: planCharacterBuildSchema.shape.reviewMedia
}).strict();

export async function saveCharacterRecipe(service: SpineService, raw: z.input<typeof saveCharacterRecipeSchema>) {
  const a = saveCharacterRecipeSchema.parse(raw);
  return operation(service, a.requestId, 'save_character_recipe', a, async () => {
    const p = await pin(service, a.plan);
    if (p.sha256 !== a.expectedSha256) throw Error('Character plan changed.');
    const plan = await jsonRead(service, p.path);
    if (!['spine-character-build/1', 'spine-motion-pack/1'].includes(plan.schema) || plan.version !== VERSION || !plan.checksPassed)
      throw Error('Recipe requires a passing current-build construction or motion-pack plan.');
    await verifySource(service, plan.source); await verifyPins(service, plan.pins);
    const parsed = constructionSchema.parse(plan.schema === 'spine-character-build/1' ? plan.args.construction : plan.construction);
    const { psd: _psd, landmarkConfirmation: _review, expectedDataSha256: _digest, ...construction } = parsed;
    const templatePins = await Promise.all(construction.templates.map(t => pin(service, t.template)));
    const report = {
      schema: 'spine-character-recipe/1', version: VERSION, name: a.name, construction, templatePins,
      originPlan: p, coordinatesAreExplicit: true, namesAreLiteral: true,
      freshLandmarkReviewRequired: true, inheritedVisualAcceptance: false,
      scope: 'Reusable preparation, controller and motion parameters. PSD plans, source hashes, task receipts and prior review decisions are never reused.'
    };
    const f = await immutableJson(service, 'character-recipes', report);
    return { ...report, recipe: f.path, recipeSha256: f.sha256, pinnedFiles: [f, ...templatePins] };
  });
}

export async function planCharacterRecipe(service: SpineService, raw: z.input<typeof planCharacterRecipeSchema>) {
  const a = planCharacterRecipeSchema.parse(raw), p = await pin(service, a.recipe);
  if (p.sha256 !== a.expectedSha256) throw Error('Character recipe changed.');
  const recipe = await jsonRead(service, p.path);
  if (recipe.schema !== 'spine-character-recipe/1' || recipe.version !== VERSION) throw Error('Incompatible character recipe.');
  await verifyPins(service, recipe.templatePins);
  const plan = await planCharacterBuild(service, {
    input: a.input, name: a.name,
    construction: { ...recipe.construction, ...a.overrides, ...(a.psd ? { psd: a.psd } : {}) },
    publication: a.publication, reviewMedia: a.reviewMedia
  });
  return { ...plan, recipe: p, freshLandmarkReviewRequired: true, finalCandidateReviewRequired: true, inheritedVisualAcceptance: false };
}
