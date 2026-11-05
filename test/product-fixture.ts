import path from 'node:path';import os from 'node:os';import {mkdtemp,realpath,mkdir,writeFile} from 'node:fs/promises';
import {SpineService} from '../src/service.js';import {parseDocument,writeDocument} from '../src/document.js';import {encodePng} from '../src/raster.js';import {humanoidRoles,type RigDefinition} from '../src/product-rig.js';
export function productData(scale=1){
 const bone=(name:string,parent?:string,x=0,y=0,length=0,rotation=0)=>({name,...(parent?{parent}:{}),x:x*scale,y:y*scale,length:length*scale,rotation});
 return parseDocument({
  skeleton:{spine:'4.3.23',fps:30,images:'./images'},
  bones:[bone('root'),bone('pelvis','root',0,160),bone('chest','pelvis',0,40),bone('head','chest',0,50),bone('arm_L_upper','chest',-12,20,45,170),bone('arm_L_lower','arm_L_upper',45,0,40,10),bone('hand_L','arm_L_lower',40,0,15),bone('arm_R_upper','chest',12,20,45,10),bone('arm_R_lower','arm_R_upper',45,0,40,-10),bone('hand_R','arm_R_lower',40,0,15),bone('leg_L_upper','pelvis',-15,0,65,-95),bone('leg_L_lower','leg_L_upper',65,0,60,10),bone('foot_L','leg_L_lower',60,0,20,85),bone('leg_R_upper','pelvis',15,0,65,-85),bone('leg_R_lower','leg_R_upper',65,0,60,-10),bone('foot_R','leg_R_lower',60,0,20,95)],
  slots:[{name:'body',bone:'pelvis',attachment:'body'},{name:'face',bone:'head',attachment:'neutral'}],
  skins:[{name:'default',attachments:{body:{body:{path:'art',width:8,height:8}},face:{neutral:{path:'art',width:8,height:8},open:{path:'open',width:8,height:8},closed:{path:'closed',width:8,height:8}}}}],
  animations:{
   source:{bones:{head:{rotate:[{time:0,value:0},{time:1,value:2}]},root:{translate:[{time:0,x:0,y:0},{time:1,x:1,y:0}]}}},
   ordered:{bones:{root:{rotate:[{time:0,value:0},{time:1,value:2}]}},drawOrder:[{time:0,offsets:[{slot:'body',offset:1}]}]}
  }
 });
}
export const productDefinition:RigDefinition={kind:'humanoid_full',roles:Object.fromEntries(humanoidRoles.map(r=>[r,r])),limbs:[{name:'left-leg',upper:'leg_L_upper',lower:'leg_L_lower',end:'foot_L',direct:true,bend:'any',heel:{x:0,y:-3},toe:{x:20,y:-3}},{name:'right-leg',upper:'leg_R_upper',lower:'leg_R_lower',end:'foot_R',direct:true,bend:'any',heel:{x:0,y:-3},toe:{x:20,y:-3}}],limits:[{role:'head',min:-30,max:30},{role:'leg_L_lower',min:-90,max:90},{role:'leg_R_lower',min:-90,max:90}],parts:[{role:'face',skin:'default',slot:'face',attachment:'neutral'}],secondary:[],seamPlans:[]};
export async function productFixture(scale=1){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'spine-product-'))),service=new SpineService({targetVersion:'4.3.23',workspaceRoot:root,cliExecutable:null,guiExecutable:null,cliTimeoutMs:1000});await mkdir(path.join(root,'images'));for(const[name,color]of [['art',[220,180,120,255]],['open',[60,180,240,255]],['closed',[220,60,120,255]]]as const){const p=new Uint8Array(256);for(let y=1;y<7;y++)for(let x=1;x<7;x++)p.set(color,(y*8+x)*4);await writeFile(path.join(root,'images',name+'.png'),encodePng(8,8,p));}const mask=new Uint8Array(256);mask.set([255,255,255,255],(2*8+2)*4);const protect=path.join(root,'mask.png');await writeFile(protect,encodePng(8,8,mask));const data=productData(scale),input=(await writeDocument(service.workspace,'source.json',data)).path;return{root,service,data,input,art:path.join(root,'images/art.png'),open:path.join(root,'images/open.png'),closed:path.join(root,'images/closed.png'),protect};}
