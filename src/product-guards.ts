import path from 'node:path';
import type { SpineService } from './service.js';
export async function requireManagedFile(service:SpineService,file:string,kind:string,basename='manifest.json'){
 const root=await service.workspace.resolve(kind,false),resolved=await service.workspace.resolve(file),relative=path.relative(root,resolved),parts=relative.split(path.sep);
 if(relative.startsWith('..')||path.isAbsolute(relative)||parts.length!==2||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(parts[0]!)||parts[1]!==basename)throw Error('Artifact is outside its managed '+kind+' inventory.');
 return resolved;
}
