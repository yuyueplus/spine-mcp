import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './config.js';
import type { SpineCli } from './cli.js';
import { applyEdits, type ProjectEdit } from './edits.js';
import { object, readDocument, writeDocument, type JsonObject, type SpineDocument } from './document.js';
import { colorRgba } from './slot-data.js';
import { decodeDrawOrder, effectiveEvent } from './animation-data.js';
import { constraintList, constraintTracks, normalizedConstraint, normalizedConstraintKey, constraintIdentity } from './constraint-data.js';
import { verifyGeometry, reorderedTriangleAttachments } from './geometry-verification.js';
import { checkpoint, type WorkControl } from './progress.js';
import { verifyExtraTracks } from './timeline-verification.js';
import { compileFolderDrawOrder } from './draw-order-compilation.js';
import { canonicalizeWeights } from './weight-order.js';
import { fileSha256 } from './file-hash.js';
import { auditAssets, assertSnapshot, snapshotEditSources } from './production-assets.js';
import { equivalentNativeCurve } from './curve-equivalence.js';
export { fileSha256 } from './file-hash.js';

const closeEnough = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => closeEnough(value, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as JsonObject, right = b as JsonObject;
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && closeEnough(left[key], right[key]));
  }
  return a === b;
};
function skins(data: SpineDocument): JsonObject[] {
  return Array.isArray(data.skins) ? data.skins.map(skin => object(skin, 'skin')) : [];
}
function identities(data: SpineDocument) {
  const attachments: string[] = [];
  for (const skin of skins(data)) for (const [slot, items] of Object.entries(object(skin.attachments ?? {}, 'attachments'))) {
    for (const attachment of Object.keys(object(items, 'slot attachments'))) attachments.push(JSON.stringify([skin.name, slot, attachment]));
  }
  const constraints: string[] = [];
  for (const kind of ['constraints', 'ik', 'transform', 'path', 'physics']) for (const item of (data[kind] ?? []) as JsonObject[]) constraints.push(JSON.stringify([kind, item.type ?? '', item.name]));
  return {
    bones: data.bones.map(bone => JSON.stringify([bone.name, bone.parent ?? ''])).sort(),
    slots: (data.slots ?? []).map(slot => JSON.stringify([slot.name, slot.bone])).sort(),
    skins: skins(data).map(skin => String(skin.name)).sort(),
    attachments: attachments.sort(), animations: Object.keys(data.animations ?? {}).sort(),
    events: Object.keys((data.events ?? {}) as JsonObject).sort(), constraints: constraints.sort(),
  };
}

// Compare semantic defaults rather than JSON text: Spine omits zero/default
// values and writes its own hash and export bounds on a round-trip.
export function verifyRoundTrip(expected: SpineDocument, actual: SpineDocument, expectedPath: string, actualPath: string) {
  const folderAnimations = Object.entries(expected.animations ?? {}).filter(([_name, animation]) => Array.isArray(animation.drawOrderFolder) && animation.drawOrderFolder.length).map(([name]) => name);
  expected = canonicalizeWeights(compileFolderDrawOrder(expected), true); actual = canonicalizeWeights(compileFolderDrawOrder(actual), true);
  const issues: string[] = [...verifyGeometry(expected, actual, closeEnough), ...verifyExtraTracks(expected, actual, closeEnough)];
  let normalizedCurveSegments = 0, maxNormalizedValueBound = 0;
  const curveEqual = (left: JsonObject, nextLeft: JsonObject | undefined, right: JsonObject, nextRight: JsonObject | undefined, values: (key: JsonObject) => number[]) => {
    if (closeEnough(left.curve, right.curve)) return true;
    const result = equivalentNativeCurve(left, nextLeft, right, nextRight, values, closeEnough);
    if (result.equivalent) { normalizedCurveSegments++; maxNormalizedValueBound = Math.max(maxNormalizedValueBound, result.maxValueBound); }
    return result.equivalent;
  };
  if (expected.skeleton.spine !== actual.skeleton.spine) issues.push('Editor version differs.');
  const before = identities(expected), after = identities(actual);
  for (const category of Object.keys(before) as (keyof typeof before)[]) if (JSON.stringify(before[category]) !== JSON.stringify(after[category])) issues.push(`${category} identities changed.`);
  if (JSON.stringify(constraintList(expected).map(constraintIdentity)) !== JSON.stringify(constraintList(actual).map(constraintIdentity))) issues.push('Constraint execution order differs.');
  for (const constraint of constraintList(expected)) {
    const received = constraintList(actual).find(item => item.name === constraint.name && item.type === constraint.type);
    if (received && !closeEnough(normalizedConstraint(constraint), normalizedConstraint(received))) issues.push(`Constraint ${String(constraint.name)} definition differs.`);
  }
  for (const [name, raw] of Object.entries(object(expected.events ?? {}, 'events'))) {
    const definitions = object(actual.events ?? {}, 'events');
    if (!Object.hasOwn(definitions, name)) continue;
    const left = object(raw, 'event definition'), right = object(definitions[name], 'event definition');
    for (const [field, fallback] of Object.entries({ int: 0, float: 0, string: '', audio: null, volume: 1, balance: 0 })) {
      if (!closeEnough(left[field] ?? fallback, right[field] ?? fallback)) issues.push(`Event ${name}.${field} default differs.`);
    }
  }
  if (Array.isArray(expected.constraints)) for (const raw of expected.constraints) {
    const constraint = object(raw, 'constraint');
    if (constraint.type !== 'slider') continue;
    const found = constraintList(actual).find(item => item.type === 'slider' && item.name === constraint.name);
    if (found && object(found, 'constraint').animation !== constraint.animation) issues.push(`Slider ${String(constraint.name)} animation differs after canonical import: expected ${String(constraint.animation)}, received ${String(object(found, 'constraint').animation)}. No output was published.`);
  }
  for (const bone of expected.bones) {
    const found = actual.bones.find(item => item.name === bone.name);
    if (!found) continue;
    for (const field of ['x', 'y', 'rotation', 'length', 'scaleX', 'scaleY', 'shearX', 'shearY']) {
      const fallback = field === 'scaleX' || field === 'scaleY' ? 1 : 0;
      if (!closeEnough(bone[field] ?? fallback, found[field] ?? fallback)) issues.push(`Bone ${bone.name}.${field} differs.`);
    }
  }
  if (JSON.stringify((expected.slots ?? []).map(slot => slot.name)) !== JSON.stringify((actual.slots ?? []).map(slot => slot.name))) issues.push('Setup slot draw order differs.');
  for (const slot of expected.slots ?? []) {
    const found = actual.slots?.find(item => item.name === slot.name);
    if (!found) continue;
    for (const [field, fallback] of Object.entries({ attachment: null, blend: 'normal', visible: true, dark: null })) {
      const normalize = (value: unknown) => typeof value === 'string' && field === 'dark' ? value.toLowerCase() : value;
      if (!closeEnough(normalize(slot[field] ?? fallback), normalize(found[field] ?? fallback))) issues.push(`Slot ${slot.name}.${field} differs.`);
    }
    if (colorRgba(slot.color ?? 'ffffffff') !== colorRgba(found.color ?? 'ffffffff')) issues.push(`Slot ${slot.name}.color differs.`);
  }
  for (const skin of skins(expected)) {
    const receivedSkin = skins(actual).find(item => item.name === skin.name);
    if (!receivedSkin) continue;
    for (const field of ['bones', 'ik', 'transform', 'path', 'physics', 'slider']) {
      if (JSON.stringify([...(skin[field] ?? []) as string[]].sort()) !== JSON.stringify([...(receivedSkin[field] ?? []) as string[]].sort())) issues.push(`Skin ${String(skin.name)}.${field} membership differs.`);
    }
    for (const [slotName, rawItems] of Object.entries(object(skin.attachments ?? {}, 'attachments'))) {
      const receivedItems = object(object(receivedSkin.attachments ?? {}, 'attachments')[slotName] ?? {}, 'slot attachments');
      for (const [placeholder, raw] of Object.entries(object(rawItems, 'slot attachments'))) {
        const attachment = object(raw, 'attachment');
        if ((attachment.type ?? 'region') !== 'region' || attachment.sequence !== undefined || !Object.hasOwn(receivedItems, placeholder)) continue;
        const received = object(receivedItems[placeholder], 'attachment'), label = `${String(skin.name)}/${slotName}/${placeholder}`;
        if ((received.type ?? 'region') !== 'region' || received.sequence !== undefined) issues.push(`Region type differs: ${label}.`);
        for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'width', 'height']) {
          const fallback = field === 'scaleX' || field === 'scaleY' ? 1 : 0;
          if (!closeEnough(attachment[field] ?? fallback, received[field] ?? fallback)) issues.push(`Region ${label}.${field} differs.`);
        }
        if ((attachment.name ?? placeholder) !== (received.name ?? placeholder) || (attachment.path ?? attachment.name ?? placeholder) !== (received.path ?? received.name ?? placeholder)) issues.push(`Region name or image path differs: ${label}.`);
        if (colorRgba(attachment.color ?? 'ffffffff') !== colorRgba(received.color ?? 'ffffffff')) issues.push(`Region ${label}.color differs.`);
      }
    }
  }
  for (const [animationName, animation] of Object.entries(expected.animations ?? {})) {
    const actualAnimation = actual.animations?.[animationName];
    if (!actualAnimation) continue;
    const expectedConstraints = constraintTracks(expected, animation), actualConstraints = constraintTracks(actual, actualAnimation);
    if (expectedConstraints.length !== actualConstraints.length) issues.push(`Constraint timeline inventory differs: ${animationName}.`);
    for (const track of expectedConstraints) {
      const received = actualConstraints.find(item => item.type === track.type && item.name === track.name && item.channel === track.channel);
      if (!received || !closeEnough(track.frames.map(key => normalizedConstraintKey(track.type, track.channel, key)), received.frames.map(key => normalizedConstraintKey(track.type, track.channel, key)))) issues.push(`Constraint keys differ: ${animationName}/${track.name}/${track.channel}.`);
    }
    for (const group of ['bones', 'slots']) {
      const inventory = (value: unknown) => Object.entries(object(value ?? {}, group)).flatMap(([entity, raw]) => Object.keys(object(raw, 'channels')).map(channel => JSON.stringify([entity, channel]))).sort();
      if (JSON.stringify(inventory(animation[group])) !== JSON.stringify(inventory(actualAnimation[group]))) issues.push(`Timeline inventory differs: ${animationName}/${group}.`);
    }
    for (const [boneName, channels] of Object.entries(object(animation.bones ?? {}, 'bone timelines'))) {
      const actualChannels = object((object(actualAnimation.bones ?? {}, 'bone timelines'))[boneName] ?? {}, 'bone channels');
      for (const [channel, rawFrames] of Object.entries(object(channels, 'bone channels'))) {
        if (!['rotate', 'translate', 'scale', 'shear'].includes(channel)) continue;
        const frames = rawFrames as JsonObject[];
        const received = actualChannels[channel];
        const label = `${animationName}/${boneName}/${channel}`;
        if (!Array.isArray(received) || received.length !== frames.length) { issues.push(`Keyframe count differs: ${label}.`); continue; }
        for (let index = 0; index < frames.length; index++) {
          const left = frames[index]!, right = object(received[index], 'keyframe');
          const fallback = channel === 'scale' ? 1 : 0;
          const fields = channel === 'rotate' ? ['time', 'value'] : ['time', 'x', 'y'];
          for (const field of fields) if (!closeEnough(left[field] ?? (field === 'time' ? 0 : fallback), right[field] ?? (field === 'time' ? 0 : fallback))) issues.push(`Keyframe ${label}[${index}].${field} differs.`);
          const nextLeft = frames[index + 1], nextRight = received[index + 1] as JsonObject | undefined;
          if (!curveEqual(left, nextLeft, right, nextRight, key => fields.filter(field => field !== 'time').map(field => Number(key[field] ?? fallback)))) issues.push(`Curve differs: ${label}[${index}].`);
        }
      }
    }
    for (const [slotName, rawChannels] of Object.entries(object(animation.slots ?? {}, 'slot timelines'))) {
      const actualChannels = object(object(actualAnimation.slots ?? {}, 'slot timelines')[slotName] ?? {}, 'slot channels');
      for (const [channel, rawFrames] of Object.entries(object(rawChannels, 'slot channels'))) {
        if (!['attachment', 'rgba'].includes(channel)) continue;
        const frames = rawFrames as JsonObject[], received = actualChannels[channel], label = `${animationName}/${slotName}/${channel}`;
        if (!Array.isArray(received) || received.length !== frames.length) { issues.push(`Slot keyframe count differs: ${label}.`); continue; }
        frames.forEach((left, index) => {
          const right = object(received[index], 'slot keyframe');
          if (!closeEnough(left.time ?? 0, right.time ?? 0)) issues.push(`Slot keyframe ${label}[${index}].time differs.`);
          if (channel === 'attachment' && (left.name ?? null) !== (right.name ?? null)) issues.push(`Slot keyframe ${label}[${index}].attachment differs.`);
          if (channel === 'rgba') {
            if (colorRgba(left.color) !== colorRgba(right.color)) issues.push(`Slot keyframe ${label}[${index}].color differs.`);
            const nextLeft = frames[index + 1], nextRight = received[index + 1] as JsonObject | undefined;
            if (!curveEqual(left, nextLeft, right, nextRight, key => colorRgba(key.color).match(/../g)!.map(v => parseInt(v, 16) / 255))) issues.push(`Slot curve differs: ${label}[${index}].`);
          }
        });
      }
    }
    const leftEvents = (animation.events ?? []) as JsonObject[], rightEvents = (actualAnimation.events ?? []) as JsonObject[];
    if (leftEvents.length !== rightEvents.length) issues.push(`Event keyframe count differs: ${animationName}.`);
    else {
      const canonical = (data: SpineDocument, frames: JsonObject[]) => frames.map(key => effectiveEvent(data, key)).sort((a, b) => Number(a.time) - Number(b.time) || String(a.name).localeCompare(String(b.name)) || Number(a.int) - Number(b.int) || Number(a.float) - Number(b.float) || String(a.string).localeCompare(String(b.string)));
      const left = canonical(expected, leftEvents), right = canonical(actual, rightEvents);
      left.forEach((event, index) => {
        const received = right[index]!;
        for (const field of Object.keys(event) as (keyof typeof event)[]) if (!closeEnough(event[field], received[field])) issues.push(`Event keyframe ${animationName}[${index}].${field} differs.`);
      });
    }
    const leftDraw = (animation.drawOrder ?? []) as JsonObject[], rightDraw = (actualAnimation.drawOrder ?? []) as JsonObject[];
    if (leftDraw.length !== rightDraw.length) issues.push(`Draw-order keyframe count differs: ${animationName}.`);
    else leftDraw.forEach((key, index) => {
      if (!closeEnough(key.time ?? 0, rightDraw[index]!.time ?? 0) || JSON.stringify(decodeDrawOrder(expected, key)) !== JSON.stringify(decodeDrawOrder(actual, rightDraw[index]!))) issues.push(`Draw-order keyframe differs: ${animationName}[${index}].`);
    });
  }
  for (const field of ['images', 'audio']) {
    if (typeof expected.skeleton[field] !== 'string' || !expected.skeleton[field]) continue;
    const absolute = (filename: string, value: unknown) => {
      const resolved = path.resolve(path.dirname(filename), String(value ?? ''));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (absolute(expectedPath, expected.skeleton[field]) !== absolute(actualPath, actual.skeleton[field])) issues.push(`${field} resource path differs.`);
  }
  if (issues.length) throw new Error(`Round-trip verification failed: ${issues.slice(0, 12).join(' ')}`);
  const triangleChanges = reorderedTriangleAttachments(expected, actual);
  return { passed: true, ...(normalizedCurveSegments ? { nativeCurveNormalization: { segments: normalizedCurveSegments, maxPerComponentValueBound: maxNormalizedValueBound, method: 'Bezier ordinate convex-hull bound' } } : {}), ...(triangleChanges.length ? { triangleOrderNormalization: { attachments: triangleChanges, orientedTopologyPreserved: true, selfOverlapOrderPreserved: false, note: 'Editor reordered equivalent faces. Review visual ordering if the animated mesh self-overlaps.' } } : {}), ...(folderAnimations.length ? { folderDrawOrderNormalization: { animations: folderAnimations, representation: 'equivalent global slot permutations', editorFolderStructurePreserved: false } } : {}), checks: ['editor version', 'bone hierarchy and setup transforms', 'slot, skin, attachment, event, constraint and animation identities', 'setup slot draw order, attachment, color and blending', 'skin membership; region paths, transforms, sizes and colors; mesh UVs, oriented triangle topology, vertices, weights and linked sources', 'bone and slot timeline inventory', 'bone transform, individual-axis and inherit keys; supported slot color channels and curves', 'slot attachment and RGBA keyframes and curves', 'event defaults and effective event payloads (simultaneous order ignored)', 'global draw-order keyframe times and resolved slot permutations', 'five constraint definitions, execution order, parameter keys and curves', 'attachment deform and sequence keys', 'folder draw-order permutations compiled to equivalent global keys', 'slider animation references', 'image and audio resource paths'] };
}

type ProjectCli = { exportData: (...args: Parameters<SpineCli['exportData']>) => Promise<{ files: string[]; geometryReadback?: { skeleton: string; attachments: number; deformTracks: number; binary: string }[] }>; importProject: (...args: Parameters<SpineCli['importProject']>) => Promise<{ path: string }> };
export async function editProject(workspace: Workspace, cli: ProjectCli, input: string, output: string, edits: ProjectEdit[], skeletonName?: string, control?: WorkControl) {
  await checkpoint(control, { phase: 'load', completed: 0, total: 5 });
  const source = await workspace.resolve(input);
  const destination = await workspace.resolve(output, false);
  if (path.extname(destination).toLowerCase() !== '.spine') throw new Error('Project output must end in .spine.');
  try { await stat(destination); throw new Error('Output already exists. Choose a new .spine path.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const originalSha256 = await fileSha256(source);
  let jsonPath = source;
  let importedName = skeletonName;
  if (path.extname(source).toLowerCase() === '.spine') {
    const exported = await cli.exportData(source);
    const files = exported.files.filter(file => file.toLowerCase().endsWith('.json'));
    if (files.length !== 1) throw new Error('spine_edit_project currently requires a single-skeleton project. No output was published. Use individual skeleton tools for multi-skeleton data.');
    jsonPath = files[0]!;
    const actualName = path.basename(jsonPath, '.json');
    if (skeletonName && skeletonName !== actualName) throw new Error(`Skeleton name is ${actualName}; the workflow preserves this name.`);
    importedName = actualName;
  } else if (path.extname(source).toLowerCase() !== '.json') throw new Error('Input must be .spine or .json.');
  importedName ??= path.basename(source, path.extname(source));
  await checkpoint(control, { phase: 'edit', completed: 1, total: 5 });
  const sourceData = await readDocument(jsonPath), resources = await auditAssets(workspace, sourceData, jsonPath, false), dependencies = await snapshotEditSources(workspace, edits);
  const edited = await applyEdits(sourceData, edits, { workspace, jsonPath });
  const editedResources = await auditAssets(workspace, edited, jsonPath, false);
  const jobs = await workspace.resolve('.jobs', false);
  await mkdir(jobs, { recursive: true });
  const job = await mkdtemp(path.join(jobs, 'edit-project-'));
  const working = await writeDocument(workspace, path.join(job, 'edited.json'), edited, path.dirname(jsonPath));
  await mkdir(path.dirname(destination), { recursive: true });
  const candidate = path.join(path.dirname(destination), `.mcp-verify-${randomUUID()}.spine`);
  const reportPath = path.join(job, 'verification.json');
  let ownCandidate = false;
  try {
    await checkpoint(control, { phase: 'import', completed: 2, total: 5 });
    await cli.importProject(working.path, candidate, importedName, control);
    ownCandidate = true;
    await checkpoint(control, { phase: 'export', completed: 3, total: 5 });
    const exported = await cli.exportData(candidate);
    const actualJson = exported.files.find(file => file.toLowerCase().endsWith('.json'));
    if (!actualJson || exported.files.filter(file => file.toLowerCase().endsWith('.json')).length !== 1) throw new Error('Expected exactly one skeleton after import.');
    const verification = verifyRoundTrip(await readDocument(working.path), await readDocument(actualJson), working.path, actualJson);
    await checkpoint(control, { phase: 'verify', completed: 4, total: 5 });
    await assertSnapshot(resources);
    await assertSnapshot(editedResources);
    await assertSnapshot(dependencies);
    if (await fileSha256(source) !== originalSha256) throw new Error('The source file changed while the workflow was running. No output was published; retry after saving your changes.');
    const report = { source, sourceSha256: originalSha256, originalUnchanged: true, output: destination, skeletonName: importedName, workingJson: working.path, exportedJson: actualJson, binaryGeometryReadback: exported.geometryReadback ?? [], edits, verification, published: false, note: 'Checks cover the listed exported data. JSON round-trips may omit editor-only information; keep the original .spine.' };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    await checkpoint(control, { phase: 'publish', completed: 5, total: 5 });
    await copyFile(candidate, destination, constants.COPYFILE_EXCL);
    report.published = true;
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    return { ...report, reportPath };
  } finally { if (ownCandidate) await unlink(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
