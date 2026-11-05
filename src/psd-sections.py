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
    if source.stat().st_size>32*1024**2:raise ValueError('PSD source exceeds 32 MiB')
    before=hashlib.sha256(source.read_bytes()).hexdigest()
    if before!=request['sourceSha256']:raise ValueError('PSD source changed')
    with source.open('rb') as f:header=f.read(26)
    if header[:6]!=b'8BPS\0\1' or int.from_bytes(header[22:24],'big')!=8 or int.from_bytes(header[24:26],'big')!=3:raise ValueError('Selected sections require standard RGB8 PSD')
    psd=PSDImage.open(source)
    if len(list(psd.descendants()))>1024:raise ValueError('PSD section metadata exceeds 1024 layers/groups')
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
    return {'checksPassed':True,'width':w,'height':h,'units':units,'comparison':comparison,'sourceLayers':len(list(psd.descendants())),'selectedLayers':len(descendants),'reference':'Original PSD selected-group compositor; saved whole-document merged preview is not used as the renderer','scope':'Only the explicit group and document viewport; hidden variants and child editing semantics are not retained in flattened units','versions':versions()}

if __name__=='__main__':
    try:
        p=pathlib.Path(sys.argv[1]).resolve(strict=True)
        if p.stat().st_size>65536:raise ValueError('Oversized PSD section request')
        print(json.dumps(extract(json.loads(p.read_text(encoding='utf-8')))))
    except Exception as e:
        print(json.dumps({'error':str(e)}));sys.exit(1)
