import { getLayerImageData, getLayerMaskImageData, type Psd, type Layer } from 'ag-psd';
import { inflateSync } from 'node:zlib';
export type PsdComposition = { blockers: { layer: string; reason: string }[]; warnings: string[]; operations: { type: string; layers: string[]; output: string }[] };
type Raster = { left: number; top: number; width: number; height: number; data: Uint8ClampedArray };
type Budget = { pixels: number; calls: number };
function consume(budget:Budget|undefined,pixels:number){if(budget&&(++budget.calls>2048||(budget.pixels+=pixels)>64000000))throw Error('PSD compositing exceeds intermediate raster/work budget.');}
const supported = new Set(['normal', 'multiply', 'screen', 'linear dodge']), tags = new Set(['bone','slot','skin','folder','path','pad','trim','bones','slots','ignore','origin','merge']);
function dimensions(left: number, top: number, width: number, height: number) { if (![left,top,width,height].every(Number.isSafeInteger) || Math.abs(left)>1000000 || Math.abs(top)>1000000 || width<0 || height<0 || width>8192 || height>8192 || width*height>16777216) throw Error('PSD raster geometry exceeds its budget.'); }
function rle(bytes: Uint8Array, width: number, height: number) {
  if (bytes.length<height*2) throw Error('Truncated PSD RLE table.'); const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); let at=height*2;
  for(let y=0;y<height;y++){const end=at+v.getUint16(y*2);let decoded=0;if(end>bytes.length)throw Error('Truncated PSD RLE row.');while(at<end){const n=bytes[at++]!;if(n<128){at+=n+1;decoded+=n+1;}else if(n>128){at++;decoded+=257-n;}if(at>end||decoded>width)throw Error('Invalid PSD RLE run.');}if(decoded!==width)throw Error('Invalid PSD RLE decoded width.');}if(at!==bytes.length)throw Error('Trailing PSD RLE bytes.');
}
function channels(layer: Layer, ids: number[], width: number, height: number) {
  for(const c of layer.rawData?.channels??[])if(ids.includes(c.id)){if(!c.data)throw Error('Missing PSD channel data.');const size=width*height;if(c.compression===0&&c.data.length!==size)throw Error('Invalid PSD raw channel size.');if(c.compression===1)rle(c.data,width,height);if(c.compression===2||c.compression===3){const b=inflateSync(c.data,{maxOutputLength:Math.max(1,size)});if(b.length!==size)throw Error('Invalid PSD ZIP channel size.');}if(c.compression<0||c.compression>3)throw Error('Unsupported PSD channel compression.');}
}
function leafRaster(layer: Layer,budget?:Budget): Raster {
  const left=layer.left??0,top=layer.top??0,width=(layer.right??left)-left,height=(layer.bottom??top)-top;dimensions(left,top,width,height);if(!layer.imageData)channels(layer,[-1,0,1,2],width,height);
  if(!layer.imageData&&(!layer.rawData||![0,1,2].every(id=>layer.rawData!.channels.some(c=>c.id===id&&c.data))||layer.rawData.channels.some(c=>c.id < -2||c.id>2)))throw Error('Saved RGB channels with optional alpha/pixel-mask are required; spot/extra channels are unsupported.');
  const p=layer.imageData??getLayerImageData(layer);if(!p||!width||!height||p.width!==width||p.height!==height||!(p.data instanceof Uint8ClampedArray||p.data instanceof Uint8Array))throw Error('PSD layer needs saved RGB8 pixels.');
  consume(budget,width*height);const data=new Uint8ClampedArray(p.data),mask=layer.mask;
  if(mask&&!mask.disabled){const ml=(mask.left??0)+(mask.positionRelativeToLayer?left:0),mt=(mask.top??0)+(mask.positionRelativeToLayer?top:0),mw=(mask.right??mask.left??0)-(mask.left??0),mh=(mask.bottom??mask.top??0)-(mask.top??0);dimensions(ml,mt,mw,mh);channels(layer,[-2],mw,mh);const m=mask.imageData??getLayerMaskImageData(layer),density=mask.userMaskDensity??1;
    if(!Number.isFinite(density)||density<0||density>1)throw Error('Invalid mask density.');if((mask.userMaskFeather??0)!==0||mask.fromVectorData)throw Error('Feathered/vector-derived masks require rasterization.');
    if((mw||mh)&&(!m||m.width!==mw||m.height!==mh))throw Error('PSD mask bitmap is incomplete.');
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const mx=left+x-ml,my=top+y-mt,value=m&&mx>=0&&mx<mw&&my>=0&&my<mh?Number(m.data[(my*mw+mx)*4]):mask.defaultColor??0;data[(y*width+x)*4+3]=Math.round(data[(y*width+x)*4+3]!*(1-density+density*value/255));}
  }
  const opacity=layer.opacity??1;if(!Number.isFinite(opacity)||opacity<0||opacity>1)throw Error('Invalid PSD opacity.');for(let i=3;i<data.length;i+=4)data[i]=Math.round(data[i]!*opacity);
  return {left,top,width,height,data};
}
const modeValue=(s:number,d:number,mode:string)=>mode==='multiply'?s*d:mode==='screen'?s+d-s*d:mode==='linear dodge'?Math.min(1,s+d):s;
function blend(dst: Raster, src: Raster, mode: string, clipped=false) {
  if(!supported.has(mode))throw Error('Unsupported PSD blend mode: '+mode);
  for(let y=Math.max(dst.top,src.top);y<Math.min(dst.top+dst.height,src.top+src.height);y++)for(let x=Math.max(dst.left,src.left);x<Math.min(dst.left+dst.width,src.left+src.width);x++){
    const a=((y-src.top)*src.width+x-src.left)*4,b=((y-dst.top)*dst.width+x-dst.left)*4,sa=src.data[a+3]!/255,da=dst.data[b+3]!/255;if(!sa||clipped&&!da)continue;const oa=clipped?da:sa+da*(1-sa);
    for(let c=0;c<3;c++){const s=src.data[a+c]!/255,d=dst.data[b+c]!/255,m=modeValue(s,d,mode),v=clipped?(1-sa)*d+sa*m:((1-sa)*da*d+(1-da)*sa*s+sa*da*m)/oa;dst.data[b+c]=Math.round(Math.max(0,Math.min(1,v))*255);}if(!clipped)dst.data[b+3]=Math.round(oa*255);
  }
}
function bounds(layer:Layer):Omit<Raster,'data'>{if(layer.children){const a=layer.children.filter(l=>!l.hidden).map(bounds);if(!a.length)return{left:0,top:0,width:1,height:1};const left=Math.min(...a.map(v=>v.left)),top=Math.min(...a.map(v=>v.top));return{left,top,width:Math.max(...a.map(v=>v.left+v.width))-left,height:Math.max(...a.map(v=>v.top+v.height))-top};}return{left:layer.left??0,top:layer.top??0,width:(layer.right??0)-(layer.left??0),height:(layer.bottom??0)-(layer.top??0)};}
function rasterOf(layer: Layer,budget?:Budget): Raster {if(layer.children){const b=bounds(layer);dimensions(b.left,b.top,b.width,b.height);consume(budget,b.width*b.height);const out={...b,data:new Uint8ClampedArray(b.width*b.height*4)};for(const child of layer.children)paint(out,child,budget);return out;}return leafRaster(layer,budget);}
function paint(out:Raster,layer:Layer,budget?:Budget){if(layer.hidden)return;if(layer.children&&(layer.blendMode??'pass through')==='pass through'){for(const c of layer.children)paint(out,c,budget);}else blend(out,rasterOf(layer,budget),layer.blendMode??'normal');}
function flattened(layer: Layer, raster: Raster): Layer { return {...layer,name:(layer.name??'').replace(/\[merge\]/g,'').trim(),left:raster.left,top:raster.top,right:raster.left+raster.width,bottom:raster.top+raster.height,imageData:{width:raster.width,height:raster.height,data:raster.data},rawData:undefined,mask:undefined,realMask:undefined,children:undefined,opacity:1}; }
function groupMask(layer:Layer){const m=layer.mask;if(!m?.positionRelativeToLayer)return m;return{...m,positionRelativeToLayer:false,left:(m.left??0)+(layer.left??0),right:(m.right??0)+(layer.left??0),top:(m.top??0)+(layer.top??0),bottom:(m.bottom??0)+(layer.top??0)};}
const rigTags=(layer:Layer):boolean=>/\[(?:bone|slot|skin|folder|bones|slots)(?::|\])/.test(layer.name??'')||Boolean(layer.children?.some(rigTags));
export function preparePsdPixels(psd: Psd, ignoreHidden=true) {
  const report:PsdComposition={blockers:[],warnings:[],operations:[]},budget:Budget={pixels:0,calls:0};let count=0,pixels=0;
  const guard=(layers:Layer[],depth=0)=>{if(depth>24)throw Error('PSD exceeds 24 nested groups.');for(const l of layers){if(++count>256)throw Error('PSD exceeds 256 layers/groups, including ignored layers.');const left=l.left??0,top=l.top??0,w=(l.right??left)-left,h=(l.bottom??top)-top;dimensions(left,top,w,h);pixels+=w*h;for(const m of [l.mask,l.realMask])if(m){const w=(m.right??0)-(m.left??0),h=(m.bottom??0)-(m.top??0);dimensions(m.left??0,m.top??0,w,h);pixels+=w*h;}if(pixels>64000000)throw Error('PSD exceeds 64 million layer/mask pixels.');if(l.children)guard(l.children,depth+1);}};guard(psd.children??[]);
  function visit(list:Layer[],prefix=''):Layer[]{const normalized:Layer[]=[];
    for(const [i,original]of list.entries()){const id=prefix+i+': '+(original.name??''),l={...original};if(/\[ignore(?::[^\]]*)?\]/.test(l.name??'')||ignoreHidden&&l.hidden)continue;
      try{
        for(const match of (l.name??'').matchAll(/\[([^:\]]+)(?::[^\]]*)?\]/g))if(!tags.has(match[1]!))throw Error('Unsupported PSD tag ['+match[1]+'].');
        for(const k of ['realMask','vectorMask','adjustment','vectorFill','vectorStroke','filterEffectsMasks','artboard']as const)if(l[k])throw Error('Unsupported '+k+'; rasterize this result first.');
        if(l.effects&&!l.effects.disabled)throw Error('Layer effects need saved rasterization.');if(l.knockout||(l.fillOpacity!==undefined&&Math.abs(l.fillOpacity-1)>1e-6))throw Error('Knockout/partial fill requires rasterization.');
        if(l.blendingRanges){const b=l.blendingRanges,ranges=[b.compositeGrayBlendSource,b.compositeGraphBlendDestinationRange,...b.ranges.flatMap(r=>[r.sourceRange,r.destRange])];if(ranges.some(r=>JSON.stringify(r)!=='[0,0,255,255]'))throw Error('Non-default Blend If ranges require rasterization.');}
        if(l.children){const explicit=/\[merge\]/.test(l.name??''),children=visit(l.children,prefix+i+'.'),nonNormal=(v:Layer):boolean=>Boolean(v.blendMode&&v.blendMode!=='normal'&&v.blendMode!=='pass through'||v.children?.some(nonNormal)),pass=(l.blendMode??'pass through')==='pass through',needs=explicit||Boolean(l.mask)||l.clipping||(l.opacity??1)!==1||!pass&&((l.blendMode??'normal')!=='normal'||children.some(nonNormal));
          if(needs){if(pass&&children.some(nonNormal))throw Error('Pass-through group with interacting non-normal blends needs explicit rasterization.');if(!explicit&&children.some(rigTags))throw Error('Flattening this group would discard child rig tags. Add an explicit [merge] or restructure it.');
            const tmp={...l,children,opacity:1},r=rasterOf(tmp,budget),maskLayer={...l,mask:groupMask(l),children:undefined,left:r.left,top:r.top,right:r.left+r.width,bottom:r.top+r.height,imageData:{width:r.width,height:r.height,data:r.data}};const result=flattened({...l,blendMode:pass?'normal':l.blendMode},leafRaster(maskLayer,budget));normalized.push(result);report.operations.push({type:explicit?'merge_group':'flatten_group_compositing',layers:[id,...children.map(c=>c.name??'')],output:result.name??''});
          }else normalized.push({...l,children});
        }else{if(/\[merge\]/.test(l.name??''))throw Error('[merge] only applies to groups.');if(l.mask)report.operations.push({type:'pixel_mask',layers:[id],output:l.name??''});normalized.push(flattened(l,leafRaster(l,budget)));}
      }catch(e){report.blockers.push({layer:id,reason:(e as Error).message});}
    }
    const result:Layer[]=[];
    for(let i=0;i<normalized.length;i++){const base=normalized[i]!;if(base.clipping){report.blockers.push({layer:base.name??'',reason:'Clipping layer has no base beneath it.'});continue;}let start=i;while(start+1<normalized.length&&normalized[start+1]!.clipping)start++;
      if(start===i){result.push(base);continue;}
      try{const clips=normalized.slice(i+1,start+1);if(clips.some(rigTags))throw Error('Clipping layers with separate rig tags need explicit group merging.');if(base.blendClippendElements===false)throw Error('Ungrouped clipping blend options require rasterization.');const r=rasterOf(base,budget);for(let j=0;j<clips.length;j++)if(!clips[j]!.hidden)blend(r,rasterOf(clips[j]!,budget),clips[j]!.blendMode??'normal',true);const out=flattened(base,r);result.push(out);report.operations.push({type:'clipping_stack',layers:[base.name??'',...clips.map(c=>c.name??'')],output:out.name??''});}catch(e){report.blockers.push({layer:base.name??'',reason:(e as Error).message});}i=start;
    }
    return result;
  }
  const children=visit(psd.children??[]);return{psd:{...psd,children},report,sourceLayers:count,sourceLayerPixels:pixels};
}
export function compositePsdPixels(psd: Psd) {dimensions(0,0,psd.width,psd.height);const budget:Budget={pixels:psd.width*psd.height,calls:0},result:Raster={left:0,top:0,width:psd.width,height:psd.height,data:new Uint8ClampedArray(psd.width*psd.height*4)};for(const layer of psd.children??[])paint(result,layer,budget);return result;}
