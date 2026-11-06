"""Read-only, explicit PSD group/viewport extraction. No GUI/network/model use."""
import hashlib,json,pathlib,sys,importlib.util
from psd_tools import PSDImage
from PIL import Image
sys.dont_write_bytecode=True
_spec=importlib.util.spec_from_file_location('spine_psd_raster',pathlib.Path(__file__).with_name('psd-raster.py'))
_raster=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_raster)
versions,metric=_raster.versions,_raster.metric

def extract(request):
    versions()
    source=pathlib.Path(request['input']).resolve(strict=True)
    output=pathlib.Path(request['output']).resolve(strict=True)
    if any(output.iterdir()):raise ValueError('Section output must be a NEW empty directory')
    if source.stat().st_size>128*1024**2:raise ValueError('PSD source exceeds 128 MiB')
    before=hashlib.sha256(source.read_bytes()).hexdigest()
    if before!=request['sourceSha256']:raise ValueError('PSD source changed')
    with source.open('rb') as f:header=f.read(26)
    version=int.from_bytes(header[4:6],'big');depth=int.from_bytes(header[22:24],'big')
    if header[:4]!=b'8BPS' or version not in (1,2) or depth not in (8,16) or int.from_bytes(header[24:26],'big')!=3:raise ValueError('Selected sections require RGB8/16 PSD/PSB')
    if version==2 and not request.get('allowPsb',False):raise ValueError('PSB requires explicit allowPsb=true')
    if depth==16 and not request.get('allow16BitTo8Bit',False):raise ValueError('RGB16 conversion requires explicit allow16BitTo8Bit=true; output textures are8-bit')
    if int.from_bytes(header[14:18],'big')*int.from_bytes(header[18:22],'big')>64000000:raise ValueError('PSD canvas exceeds64MP')
    psd=PSDImage.open(source)
    if len(list(psd.descendants()))>4096:raise ValueError('PSD section metadata exceeds4096 layers/groups')
    selected=psd
    for name in request['groupPath']:
        found=[l for l in selected if l.name==name]
        if len(found)!=1 or not found[0].is_group():raise ValueError('Section path must identify one exact group at every level')
        selected=found[0]
    parent=selected
    while parent is not psd:
        if parent.opacity!=255 or parent.clipping or parent.mask is not None or parent.vector_mask is not None or any(e.enabled for e in parent.effects):raise ValueError('Section ancestors must have plain opacity/mask/style semantics')
        if str(parent.blend_mode.value) not in ["b'pass'","b'norm'"]:raise ValueError('Unsupported section ancestor blending')
        parent=parent.parent
    descendants=list(selected.descendants())
    if len(descendants)>256 or sum(max(0,l.width)*max(0,l.height) for l in descendants)>64000000:raise ValueError('Selected group exceeds layer or pixel budget')
    adjustments={'brightnesscontrast','levels','curves','exposure','huesaturation','invert','posterize','threshold'}
    for layer in descendants:
        if not layer.is_visible():continue
        if layer.kind not in {'pixel','group','type','smartobject','shape'}|adjustments:raise ValueError('Selected section has an unsupported active layer kind: '+layer.name)
        if layer.vector_mask is not None and sum(len(p) if hasattr(p,'__len__') else 1 for p in layer.vector_mask.paths)>20000:raise ValueError('Selected vector mask exceeds 20,000 knots')
        if any(e.enabled and type(e).__name__!='Stroke' for e in layer.effects):raise ValueError('Selected section has an unsupported active layer style: '+layer.name)
    r=request['viewport'];x,y,w,h=r['x'],r['y'],r['width'],r['height']
    if min(w,h)<1 or max(w,h)>4096 or w*h>4194304:raise ValueError('Section viewport exceeds four megapixels')
    if x<0 or y<0 or x+w>psd.width or y+h>psd.height:raise ValueError('Section viewport exceeds document bounds')
    children=[l for l in selected if l.is_visible()]
    if len(children)>32 or len(children)*w*h>64000000:raise ValueError('Selected section exceeds unit/output pixel budget')
    viewport=(x,y,x+w,y+h)
    reference=selected.composite(viewport=viewport,force=False,apply_icc=False)
    if reference is None:raise ValueError('Selected group has no composite')
    reference=reference.convert('RGBA');reference.save(output/'reference.png')
    combined=Image.new('RGBA',(w,h));units=[]
    for layer in children:
        if layer.clipping or str(layer.blend_mode.value) not in ["b'pass'","b'norm'"]:raise ValueError('Section units depend on a sibling backdrop; flatten a larger explicit group instead')
        image=layer.composite(viewport=viewport,force=False,apply_icc=False)
        if image is None:continue
        image=image.convert('RGBA');bbox=image.getbbox()
        if bbox is None:continue
        cropped=image.crop(bbox);name='part-%04d.png'%len(units);cropped.save(output/name)
        combined.alpha_composite(cropped,(bbox[0],bbox[1]))
        units.append({'name':layer.name,'image':name,'left':bbox[0],'top':bbox[1],'width':cropped.width,'height':cropped.height})
    comparison=metric(combined,reference)
    combined.save(output/'recomposed.png')
    if comparison['maxPremultipliedError']>=3 or comparison['meanPremultipliedError']>=.35:raise ValueError('Independent section units do not reproduce the original group composite')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=before:raise ValueError('PSD changed during section extraction')
    return {'checksPassed':True,'width':w,'height':h,'units':units,'comparison':comparison,'sourceLayers':len(list(psd.descendants())),'selectedLayers':len(descendants),'sourceVersion':version,'sourceBitDepth':depth,'outputBitDepth':8,'explicitBitDepthConversion':depth==16,'reference':'Original PSD selected-group compositor; saved whole-document merged preview is not used as the renderer','scope':'Only the explicit group and document viewport; hidden variants and child editing semantics are not retained in flattened units','versions':versions()}

def inspect_source(request):
    versions();source=pathlib.Path(request['input']).resolve(strict=True)
    if source.stat().st_size>128*1024**2:raise ValueError('PSD source exceeds128MiB')
    before=hashlib.sha256(source.read_bytes()).hexdigest()
    if before!=request['sourceSha256']:raise ValueError('PSD source changed')
    with source.open('rb') as f:header=f.read(26)
    if header[:4]!=b'8BPS' or int.from_bytes(header[4:6],'big') not in (1,2):raise ValueError('Not a PSD/PSB')
    info={'version':int.from_bytes(header[4:6],'big'),'depth':int.from_bytes(header[22:24],'big'),'colorMode':int.from_bytes(header[24:26],'big'),'width':int.from_bytes(header[18:22],'big'),'height':int.from_bytes(header[14:18],'big')}
    if info['width']*info['height']>64000000:raise ValueError('PSD canvas exceeds64MP')
    psd=PSDImage.open(source);layers=list(psd.descendants())
    if len(layers)>4096:raise ValueError('PSD metadata exceeds4096 layers')
    findings=[]
    for layer in layers:
        if not layer.is_visible():continue
        styles=[type(e).__name__ for e in layer.effects if e.enabled and type(e).__name__!='Stroke']
        if styles:findings.append({'layer':layer.name,'reason':'active_styles_need_explicit_rasterization','styles':styles})
        if layer.kind not in {'pixel','group','type','smartobject','shape','brightnesscontrast','levels','curves','exposure','huesaturation','invert','posterize','threshold'}:findings.append({'layer':layer.name,'reason':'unsupported_active_kind','kind':layer.kind})
    if hashlib.sha256(source.read_bytes()).hexdigest()!=before:raise ValueError('PSD changed during inspection')
    return {**info,'layers':len(layers),'groups':[{'name':l.name,'path':list(reversed([p.name for p in _parents(l)])),'children':len(list(l))} for l in layers if l.is_group()][:512],'groupsTruncated':sum(l.is_group() for l in layers)>512,'findings':findings[:128],'findingsTruncated':len(findings)>128,'formatSupported':info['colorMode']==3 and info['depth'] in (8,16),'requiresExplicitPsbOptIn':info['version']==2,'requiresExplicit8BitConversion':info['depth']==16,'sourceUnchanged':True,'scope':'Metadata/format inspection only; per-section independent composite and native proof still required'}

def _parents(layer):
    while layer is not None and not isinstance(layer,PSDImage):
        yield layer
        layer=getattr(layer,'parent',None)

if __name__=='__main__':
    try:
        p=pathlib.Path(sys.argv[1]).resolve(strict=True)
        if p.stat().st_size>65536:raise ValueError('Oversized PSD section request')
        request=json.loads(p.read_text(encoding='utf-8'))
        print(json.dumps(inspect_source(request) if request.get('operation')=='inspect' else extract(request)))
    except Exception as e:
        print(json.dumps({'error':str(e)}));sys.exit(1)
