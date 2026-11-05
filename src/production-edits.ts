import { type SpineDocument, readDocument } from './document.js';
import type { Workspace } from './config.js';
import { productionEditSchema, type ProductionEdit } from './production-schema.js';
import { relinkAssets } from './production-assets.js';
import { editKeyframes, editCurves, insertBoundary, pasteKeyframes, keyPose } from './production-keyframes.js';
import { transferAnimation, transferRig, mergeSkins } from './production-transfer.js';
import { meshFromContours, editMeshVertices, replaceMeshTopology, transferWeights } from './production-mesh.js';
import { refineSelectedTriangles } from './mesh-edits.js';
import { simplifyAnimation, selectiveBake } from './production-quality.js';
import { retargetAnimation, worldMirror, bakeAllConstraints } from './world-animation.js';
import { composeAnimation } from './animation-layers.js';
import { simplifyAdaptive } from './animation-quality.js';
import { bakeClipping } from './clipping-bake.js';
export async function applyProductionEdit(source: SpineDocument, raw: ProductionEdit, assets?: { workspace: Workspace; jsonPath: string }) {
  const edit = productionEditSchema.parse(raw);
  switch (edit.type) {
    case 'bake_clipping': if (!assets) throw new Error('Visual clipping bake requires source resource context.'); return (await bakeClipping(assets.workspace, source, assets.jsonPath, edit.animation, edit.newName, edit)).data;
    case 'world_mirror': return worldMirror(source, edit.animation, edit.newName, edit).data;
    case 'compose_animation': return composeAnimation(source, edit.newName, edit.layers, edit).data;
    case 'bake_constraints': return bakeAllConstraints(source, edit.animation, edit.newName, edit).data;
    case 'simplify_animation_adaptive': return simplifyAdaptive(source, edit.animation, edit.newName, edit).data;
    case 'relink_assets': return relinkAssets(source, edit);
    case 'edit_keyframes': return editKeyframes(source, edit.animation, edit.target, edit);
    case 'edit_curves': return editCurves(source, edit.animation, edit.target, edit.times, edit.curve);
    case 'insert_boundary_keys': { let data = source; for (const target of edit.targets) for (const time of edit.times) data = insertBoundary(data, edit.animation, target, time, edit.mode); return data; }
    case 'paste_keyframes': return pasteKeyframes(source, edit.fromAnimation, edit.toAnimation, edit.mappings, edit.start, edit.end, edit.destination, edit.collision, edit.boundaries);
    case 'key_pose': return keyPose(source, edit.animation, edit.sourceAnimation, edit.time, edit.destination, edit.bones, edit.skin, edit.collision);
    case 'merge_skins': return mergeSkins(source, edit.skins, edit.newName, edit.collision);
    case 'edit_mesh_vertices': return editMeshVertices(source, edit, edit.changes);
    case 'refine_selected_triangles': return refineSelectedTriangles(source, edit, edit.triangles);
    case 'replace_mesh_topology': return replaceMeshTopology(source, edit, edit.mesh, edit.deformPolicy);
    case 'transfer_weights': return transferWeights(source, edit.from, edit.to, edit);
    case 'simplify_animation': return simplifyAnimation(source, edit.animation, edit.newName, edit).data;
    case 'selective_bake': return selectiveBake(source, edit.animation, edit.newName, edit.constraints, edit).data;
    case 'mesh_from_contours': if (!assets) throw new Error('Contour mesh generation requires source resources.'); return meshFromContours(assets.workspace, source, assets.jsonPath, edit, edit.threshold, edit.representation);
    case 'transfer_animation': case 'transfer_rig': case 'retarget_animation': {
      if (!assets) throw new Error('Cross-project transfer requires source file context.');
      const filename = await assets.workspace.resolve(edit.source), origin = await readDocument(filename);
      return edit.type === 'retarget_animation' ? retargetAnimation(origin, source, edit.animation, edit.newName, edit).data : edit.type === 'transfer_animation' ? transferAnimation(origin, source, edit) : transferRig(origin, source, { ...edit, sourceJson: filename, targetJson: assets.jsonPath });
    }
  }
}
