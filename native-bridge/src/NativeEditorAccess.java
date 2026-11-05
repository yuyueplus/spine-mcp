import java.lang.instrument.Instrumentation;
import java.lang.reflect.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** Fixed-build interoperability adapter. No bytecode transformation or input injection. */
public final class NativeEditorAccess {
  final Instrumentation instrumentation;
  final String instanceId;
  final Path recoveryRoot;
  final Map<String,String> cachedFiles = new LinkedHashMap<String,String>();
  volatile boolean operationPending;
  final java.util.concurrent.atomic.AtomicLong inputRevision=new java.util.concurrent.atomic.AtomicLong();
  volatile boolean nativeInputTracking;

  NativeEditorAccess(Instrumentation inst,String id,Path recovery) {instrumentation=inst;instanceId=id;recoveryRoot=recovery;}
  Class<?> type(String name)throws Exception {
    for(Class<?> c:instrumentation.getAllLoadedClasses())if(c.getName().equals(name))return c;
    throw new IllegalStateException("Native type is not loaded: "+name);
  }
  static Field field(Class<?> c,String name,String valueType)throws Exception {
    for(Class<?> t=c;t!=null;t=t.getSuperclass())for(Field f:t.getDeclaredFields())if(f.getName().equals(name)&&f.getType().getName().equals(valueType)){f.setAccessible(true);return f;}
    throw new NoSuchFieldException(c.getName()+"."+name+":"+valueType);
  }
  static Method method(Class<?> c,String name,String returns,String...params)throws Exception {
    for(Class<?> t=c;t!=null;t=t.getSuperclass())for(Method m:t.getDeclaredMethods()) {
      Class<?>[] a=m.getParameterTypes();if(!m.getName().equals(name)||!m.getReturnType().getName().equals(returns)||a.length!=params.length)continue;
      boolean match=true;for(int i=0;i<a.length;i++)if(!a[i].getName().equals(params[i]))match=false;
      if(match){m.setAccessible(true);return m;}
    }
    throw new NoSuchMethodException(c.getName()+"."+name+":"+returns);
  }
  Object global(String valueType)throws Exception {return field(type("s.QxC"),"_",valueType).get(null);}
  static Object value(Object o,String name,String valueType)throws Exception {return field(o.getClass(),name,valueType).get(o);}
  static Object call(Object o,String name,String returns,String[] params,Object...args)throws Exception{return method(o.getClass(),name,returns,params).invoke(o,args);}
  Object statik(String c,String name,String returns,String[] params,Object...args)throws Exception{return method(type(c),name,returns,params).invoke(null,args);}
  static List<Object> array(Object a)throws Exception {
    if(a==null)return Collections.emptyList();int n=((Number)value(a,"_","int")).intValue();
    if(n<0||n>200000)throw new IllegalStateException("Native collection exceeds the bridge budget.");
    List<Object> out=new ArrayList<Object>(n);Method get=method(a.getClass(),"_","java.lang.Object","int");for(int i=0;i<n;i++)out.add(get.invoke(a,i));return out;
  }
  static Map<String,Object> map(Object...p){Map<String,Object> m=new LinkedHashMap<String,Object>();for(int i=0;i<p.length;i+=2)m.put((String)p[i],p[i+1]);return m;}
  static String quote(Object o){String s=String.valueOf(o);StringBuilder b=new StringBuilder("\"");for(int i=0;i<s.length();i++){char c=s.charAt(i);switch(c){case '"':b.append("\\\"");break;case '\\':b.append("\\\\");break;case '\n':b.append("\\n");break;case '\r':b.append("\\r");break;case '\t':b.append("\\t");break;default:if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}}return b.append('"').toString();}
  static String json(Object o){
    if(o==null)return "null";if(o instanceof Boolean)return o.toString();if(o instanceof Number){double d=((Number)o).doubleValue();if(!Double.isFinite(d))throw new IllegalStateException("Non-finite native number.");return o.toString();}
    if(o instanceof Map){StringBuilder b=new StringBuilder("{");int n=0;for(Map.Entry<?,?> e:((Map<?,?>)o).entrySet()){if(n++>0)b.append(',');b.append(quote(e.getKey())).append(':').append(json(e.getValue()));}return b.append('}').toString();}
    if(o instanceof Iterable){StringBuilder b=new StringBuilder("[");int n=0;for(Object v:(Iterable<?>)o){if(n++>0)b.append(',');b.append(json(v));}return b.append(']').toString();}return quote(o);
  }
  static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte v:b)s.append(String.format("%02x",v&255));return s.toString();}
  static String hash(byte[] b)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(b));}
  static String hash(Path p)throws Exception {if(!Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS)||Files.size(p)<1||Files.size(p)>128L*1024*1024)throw new IllegalArgumentException("Project must be a regular file of 1..128 MiB.");return hash(Files.readAllBytes(p));}
  Object editor()throws Exception{return global("s.COC");}
  Object project()throws Exception{return value(editor(),"_","s.WMn");}
  boolean clean()throws Exception{return (Boolean)statik("s.IyU","F","boolean",new String[0]);}
  String projectPath()throws Exception{return (String)value(project(),"L","java.lang.String");}
  String name(Object o)throws Exception {return (String)call(o,"_","java.lang.String",new String[0]);}

  Map<String,Object> model(Object project)throws Exception {
    List<Object> skeletons=new ArrayList<Object>();int totalKeys=0;
    for(Object s:array(value(project,"_","s.LVA"))) {
      List<Object> bones=new ArrayList<Object>(),slots=new ArrayList<Object>(),animations=new ArrayList<Object>(),skins=new ArrayList<Object>();
      for(Object b:array(value(s,"_","s.LVA")))bones.add(map("name",value(b,"C","java.lang.String"),"length",value(b,"L","float"),"x",value(b,"I","float"),"y",value(b,"B","float")));
      for(Object slot:array(value(s,"B","s.LVA")))slots.add(map("name",name(slot)));
      for(Object skin:array(value(s,"D","s.LVA")))skins.add(name(skin));
      for(Object a:array(value(s,"F","s.LVA"))) {
        List<Object> groups=new ArrayList<Object>();int keyCount=0;
        for(Object g:array(value(a,"_","s.LVA"))) {
          List<Object> timelines=new ArrayList<Object>();
          for(Object t:array(value(g,"_","s.LVA"))) {
            List<Object> keys=new ArrayList<Object>();
            for(Object k:array(value(t,"_","s.LVA"))) {
              if(++totalKeys>400000)throw new IllegalStateException("Keyframe budget exceeded.");keyCount++;
              Map<String,Object> d=new LinkedHashMap<String,Object>();
              for(Field f:k.getClass().getDeclaredFields())if(!Modifier.isStatic(f.getModifiers())&&(f.getType()==float.class||f.getType()==float[].class||f.getType()==int.class)){
                f.setAccessible(true);Object v=f.get(k);if(v instanceof float[]){List<Object> v2=new ArrayList<Object>();for(float x:(float[])v){if(v2.size()>65536)throw new IllegalStateException("Deform budget exceeded.");v2.add(x);}v=v2;}d.put(f.getName()+":"+f.getType().getName(),v);
              }keys.add(d);
            }
            timelines.add(map("type",String.valueOf(value(t,"_","s.IPJ")),"keys",keys));
          }groups.add(timelines);
        }
        animations.add(map("name",name(a),"durationFrames",call(a,"_","float",new String[0]),"keyCount",keyCount,"groups",groups));
      }
      skeletons.add(map("name",name(s),"bones",bones,"slots",slots,"skins",skins,"animations",animations));
    }
    String fingerprint=hash(json(skeletons).getBytes("UTF-8"));
    // Keep proof small; the hash covers the actual native key values above.
    for(Object s0:skeletons)for(Object a0:(List<?>)((Map<?,?>)s0).get("animations"))((Map<?,?>)a0).remove("groups");
    return map("sha256",fingerprint,"skeletons",skeletons,"keyCount",totalKeys);
  }
  Object timeline()throws Exception{return value(global("s.LRt"),"_","s.DgK");}
  Object controls()throws Exception{return value(timeline(),"_","s.fIg");}
  List<Object> viewActors()throws Exception {
    List<Object> actors=new ArrayList<Object>();actors.add(value(global("s.MYe"),"_","s.QWF"));actors.add(timeline());Object dopesheet=value(global("s.ESV"),"_","s.DgK");if(!actors.contains(dopesheet))actors.add(dopesheet);return actors;
  }
  boolean viewTransition(Object action){String c=action.getClass().getName();return c.equals("s.bFz")||c.equals("s.mvC")||c.equals("s.fjN");}
  int transitions(boolean finish)throws Exception {
    int count=0;for(Object actor:viewActors())for(Object action:array(call(actor,"_","s.LVA",new String[0])))if(viewTransition(action)){
      count++;if(finish){call(action,"_","boolean",new String[]{"float"},10f);call(actor,"C","void",new String[]{"s.WRN"},action);}
    }return count;
  }
  Map<String,Object> view()throws Exception {
    Object e=editor();Map<String,Object> buttons=new LinkedHashMap<String,Object>();Object c=controls();
    for(Field f:c.getClass().getDeclaredFields())if(f.getType().getName().equals("com.badlogic.gdx.scenes.scene2d.ui.ImageButton")){f.setAccessible(true);Object b=f.get(c);if(b!=null)buttons.put(f.getName(),call(b,"h","boolean",new String[0]));}
    List<Object> skels=new ArrayList<Object>();
    for(Object s:array(value(project(),"_","s.LVA"))) {
      List<Object> active=new ArrayList<Object>(),skins=new ArrayList<Object>();
      for(Object a:array(value(s,"F","s.LVA")))if((Boolean)value(a,"_","boolean"))active.add(name(a));
      for(Object skin:array(value(s,"c","s.LVA")))skins.add(name(skin));
      Object editSkin=value(s,"_","s.WiC");
      skels.add(map("name",name(s),"animations",active,"skins",skins,"editSkin",editSkin==null?null:name(editSkin)));
    }
    Map<String,Object> cameras=new LinkedHashMap<String,Object>();Object render=global("s.hHz");
    for(String cameraName:new String[]{"_","C"}) {
      Object camera=value(render,cameraName,"s.qte");if(camera==null)continue;
      Map<String,Object> vectors=new LinkedHashMap<String,Object>();
      for(String vectorName:new String[]{"_","C","S"}) {Object v=value(camera,vectorName,"s.JrP");vectors.put(vectorName,map("_",value(v,"_","float"),"C",value(v,"C","float"),"S",value(v,"S","float")));}
      cameras.put(cameraName,map("zoom",value(camera,"D","float"),"vectors",vectors));
    }
    return map("animate",value(e,"_","boolean"),"frame",value(e,"C","float"),"playing",call(e,"_","boolean",new String[0]),"playbackButtons",buttons,"skeletons",skels,"cameras",cameras,"nativeViewTransitions",transitions(false));
  }
  @SuppressWarnings("unchecked")
  List<Object> restoreView(Map<String,Object> v)throws Exception {
    List<Object> missing=new ArrayList<Object>();Object e=editor();
    statik("s.IyU","C","void",new String[]{"boolean"},true);
    try {
      if(!v.get("animate").equals(value(e,"_","boolean")))call(global("s.kER"),(Boolean)v.get("animate")?"_":"C","void",new String[0]);
      for(Object s:array(value(project(),"_","s.LVA"))) {
        Map<String,Object> prior=null;for(Object s0:(List<?>)v.get("skeletons"))if(name(s).equals(((Map<?,?>)s0).get("name")))prior=(Map<String,Object>)s0;
        if(prior==null){missing.add(map("skeleton",name(s),"reason","no_matching_previous_skeleton"));continue;}
        List<String> names=(List<String>)prior.get("animations");Set<String> found=new HashSet<String>();
        for(Object a:array(value(s,"F","s.LVA"))){boolean active=names.contains(name(a));call(a,"_","void",new String[]{"boolean"},active);if(active)found.add(name(a));}
        for(String n:names)if(!found.contains(n))missing.add(map("skeleton",name(s),"animation",n,"reason","removed"));
        List<String> skinNames=(List<String>)prior.get("skins");Object applied=value(s,"c","s.LVA");call(applied,"_","void",new String[0]);Set<String> appliedNames=new HashSet<String>();
        Object editSkin=null;for(Object skin:array(value(s,"D","s.LVA"))){if(skinNames.contains(name(skin))){call(applied,"_","void",new String[]{"java.lang.Object"},skin);appliedNames.add(name(skin));}if(name(skin).equals(prior.get("editSkin")))editSkin=skin;}
        field(s.getClass(),"_","s.WiC").set(s,editSkin);
        for(String skin:skinNames)if(!appliedNames.contains(skin))missing.add(map("skeleton",name(s),"skin",skin,"reason","removed"));
        call(s,"F","void",new String[0]);
        call(e,"_","void",new String[]{"s.pKm"},s);
      }
      call(timeline(),"K","void",new String[]{"float"},((Number)v.get("frame")).floatValue());
      transitions(true);
      restoreCamera(v);
      Object controls=controls();for(Map.Entry<?,?> b:((Map<?,?>)v.get("playbackButtons")).entrySet())call(value(controls,(String)b.getKey(),"com.badlogic.gdx.scenes.scene2d.ui.ImageButton"),"L","void",new String[]{"boolean"},b.getValue());
    } finally {statik("s.IyU","C","void",new String[]{"boolean"},false);}
    return missing;
  }
  void restoreCamera(Map<String,Object> v)throws Exception {
      Object render=global("s.hHz");
      Object viewport=value(global("s.MYe"),"_","s.xPF");
      Map<?,?> mainCamera=(Map<?,?>)((Map<?,?>)v.get("cameras")).get("_");
      if(mainCamera!=null){
        float zoom=((Number)mainCamera.get("zoom")).floatValue();Object slider=value(viewport,"_","com.badlogic.gdx.scenes.scene2d.ui.Slider");
        call(slider,"_","boolean",new String[]{"float"},((Number)value(viewport,"D","float")).floatValue()-zoom);
        for(String f:new String[]{"S","Z","I","B"})field(viewport.getClass(),f,"float").setFloat(viewport,0f);
        for(String f:new String[]{"_","C"})field(viewport.getClass(),f,"float").setFloat(viewport,zoom);
      }
      for(Map.Entry<?,?> ce:((Map<?,?>)v.get("cameras")).entrySet()){
        Object camera=value(render,(String)ce.getKey(),"s.qte");Map<?,?> cv=(Map<?,?>)ce.getValue();field(camera.getClass(),"D","float").setFloat(camera,((Number)cv.get("zoom")).floatValue());
        for(Map.Entry<?,?> ve:((Map<?,?>)cv.get("vectors")).entrySet()){Object vector=value(camera,(String)ve.getKey(),"s.JrP");for(Map.Entry<?,?> n:((Map<?,?>)ve.getValue()).entrySet())field(vector.getClass(),(String)n.getKey(),"float").setFloat(vector,((Number)n.getValue()).floatValue());}
        call(camera,"_","void",new String[0]);
      }
  }
  Map<String,Object> snapshot()throws Exception {
    Object p=project();String file=projectPath();Map<String,Object> out=map("instanceId",instanceId,"nativeThread",Thread.currentThread().getName(),"projectPath",file,"dirty",!clean(),"undoToken",String.valueOf(statik("s.IyU","_","long",new String[0])),"projectIdentity",String.valueOf(System.identityHashCode(p)),"model",model(p),"view",view());
    out.put("modalOpen",value(global("s.kER"),"_","s.IGJ")!=null);
    Object mode=value(editor(),"_","s.zXT");out.put("modeType",mode==null?null:mode.getClass().getName());
    boolean focused=false;for(java.awt.Window w:java.awt.Window.getWindows())if(w.isFocused())focused=true;
    out.put("nativeAwtWindowFocused",focused);out.put("operationPending",operationPending);out.put("nativeFrame",frameCounter());out.put("nativeInputTracking",nativeInputTracking);out.put("inputRevision",String.valueOf(inputRevision.get()));out.put("capturedAt",System.currentTimeMillis());return out;
  }
  void guard(Properties p,Map<String,Object> before)throws Exception {
    for(String key:new String[]{"instanceId","projectPath","projectIdentity","undoToken"}){
      String actual=String.valueOf(before.get(key)),expected=p.getProperty("expected."+key);
      boolean same=key.equals("projectPath")&&expected!=null?Paths.get(actual).toAbsolutePath().normalize().toString().equalsIgnoreCase(Paths.get(expected).toAbsolutePath().normalize().toString()):actual.equals(expected);
      if(!same)throw new IllegalStateException("STALE_EDITOR_STATE: "+key);
    }
    if(p.getProperty("expected.modelSha256")!=null&&!p.getProperty("expected.modelSha256").equals(((Map<?,?>)before.get("model")).get("sha256")))throw new IllegalStateException("STALE_EDITOR_STATE: native model");
    if(Boolean.TRUE.equals(before.get("dirty")))throw new IllegalStateException("UNSAVED_CHANGES: save or undo the changes before reloading.");
    if(Boolean.TRUE.equals(before.get("modalOpen")))throw new IllegalStateException("EDITOR_BUSY: close the native modal first.");
    if(transitions(false)>0)throw new IllegalStateException("EDITOR_BUSY: a native camera or pane transition is in progress.");
    Object viewport=value(global("s.MYe"),"_","s.xPF");if((Boolean)value(viewport,"_","boolean"))throw new IllegalStateException("EDITOR_BUSY: the viewport is being dragged.");
    Object mode=value(editor(),"_","s.zXT");for(Class<?> t=mode.getClass();t!=null;t=t.getSuperclass())if(t.getName().equals("s.Qwc"))throw new IllegalStateException("EDITOR_BUSY: an interactive edit is in progress.");
  }
  void install(Object p,Path path)throws Exception {
    Object e=editor(),files=global("s.RJw");field(e.getClass(),"_","s.WMn").set(e,p);
    call(files,"K","void",new String[0]);Object handle=type("s.vjd").getConstructor(String.class).newInstance(path.toString());
    call(files,"_","void",new String[]{"s.vjd","boolean","boolean"},handle,false,false);
  }
  Map<String,Object> backup(Object old,Map<String,Object> before,String requestId)throws Exception {
    if(!requestId.matches("[0-9a-f-]{36}"))throw new IllegalArgumentException("Invalid backup request identity.");
    Path original=Paths.get((String)before.get("projectPath")).toRealPath();
    Path backup=original.resolveSibling(".MCP-recovery-"+requestId+".spine");
    Files.createFile(backup); // Reserve a NEW sibling; relative image paths remain valid.
    Object handle=type("s.vjd").getConstructor(String.class).newInstance(backup.toString());
    boolean saved=(Boolean)call(global("s.hqm"),"_","boolean",new String[]{"s.WMn","s.vjd","boolean","boolean"},old,handle,false,false);
    if(!saved)throw new IllegalStateException("Native recovery snapshot could not be written; reload refused.");
    String sha=hash(backup);Object copy=call(global("s.hqm"),"_","s.WMn",new String[]{"s.vjd"},handle);
    try {
      if(!((Map<?,?>)before.get("model")).get("sha256").equals(model(copy).get("sha256")))throw new IllegalStateException("Recovery snapshot did not round-trip the native model.");
    } finally {call(copy,"S","void",new String[0]);}
    if(project()!=old||!clean()||!before.get("projectPath").equals(projectPath()))throw new IllegalStateException("Recovery snapshot changed the current editor state; reload refused.");
    return map("nativeFile",backup.toString(),"sha256",sha,"nativeModelVerified",true,"originalProjectPath",original.toString(),"relativeResourceBasePreserved",true);
  }
  static Throwable cause(Throwable e){while(e.getCause()!=null)e=e.getCause();return e;}
  interface NativeTask {void run()throws Exception;}
  Object graphics()throws Exception{return field(type("s.PrN"),"_","s.lPt5").get(null);}
  long frameCounter()throws Exception{return ((Number)method(type("s.lPt5"),"_","long").invoke(graphics())).longValue();}
  void afterFrames(final long start,final long started,final NativeTask task,final Map<String,Object>[] result,final CountDownLatch done)throws Exception {
    method(type("s.lPt5"),"_","void").invoke(graphics());
    Thread timer=new Thread(new Runnable(){public void run(){try{Thread.sleep(50);post(new NativeTask(){public void run()throws Exception {
      if(frameCounter()-start>=3&&System.currentTimeMillis()-started>=750){task.run();return;}
      if(System.currentTimeMillis()-started>15000){operationPending=false;result[0]=map("ok",false,"committed",true,"error","NATIVE_REPAINT_UNAVAILABLE: query fresh native state before another operation.","status",snapshot());done.countDown();return;}
      afterFrames(start,started,task,result,done);
    }},result,done);}catch(Throwable e){result[0]=map("ok",false,"committed",true,"error",String.valueOf(cause(e)));operationPending=false;done.countDown();}}},"Spine-MCP-render-barrier");timer.setDaemon(true);timer.start();
  }
  void post(final NativeTask t,final Map<String,Object>[] result,final CountDownLatch done)throws Exception {
    Object app=field(type("s.PrN"),"_","s.wAR").get(null);
    method(type("s.wAR"),"_","void","java.lang.Runnable").invoke(app,new Runnable(){public void run(){try{t.run();}catch(Throwable e){Throwable c=cause(e);result[0]=map("ok",false,"error",c.getClass().getName()+": "+c.getMessage());operationPending=false;done.countDown();}}});
  }
  @SuppressWarnings("unchecked")
  Map<String,Object> execute(final Properties p)throws Exception {
    final String action=p.getProperty("action");if(!"status".equals(action)&&!"reload".equals(action))throw new IllegalArgumentException("Unsupported native action.");
    final Map<String,Object>[] result=new Map[1];final CountDownLatch done=new CountDownLatch(1);
    post(new NativeTask(){public void run()throws Exception {
      if(System.currentTimeMillis()>Long.parseLong(p.getProperty("deadline",String.valueOf(Long.MAX_VALUE))))throw new IllegalStateException("REQUEST_EXPIRED: no native changes were made.");
      final Map<String,Object> before=snapshot();
      if(action.equals("status")){result[0]=map("ok",true,"status",before);done.countDown();return;}
      if(operationPending)throw new IllegalStateException("EDITOR_BUSY: another reload is still pending.");guard(p,before);
      final Path input=Paths.get(p.getProperty("input")).toRealPath();if(!input.toString().toLowerCase(Locale.ROOT).endsWith(".spine"))throw new IllegalArgumentException("Expected a .spine file.");
      if(!hash(input).equals(p.getProperty("sha256")))throw new IllegalStateException("INPUT_CHANGED: project hash does not match.");
      final Object old=project();final Map<String,Object> oldView=(Map<String,Object>)before.get("view");final long inputBefore=inputRevision.get();
      Object candidate=null;
      try {
        Object handle=type("s.vjd").getConstructor(String.class).newInstance(input.toString());candidate=call(global("s.hqm"),"_","s.WMn",new String[]{"s.vjd"},handle);
        if(project()!=old||!clean())throw new IllegalStateException("EDITOR_STATE_CHANGED_DURING_PARSE");
        if(!array(field(type("s.hqm"),"V","s.LVA").get(null)).isEmpty())throw new IllegalStateException("NATIVE_LOAD_WARNINGS: reload refused; project needs manual review.");
        if(!hash(input).equals(p.getProperty("sha256")))throw new IllegalStateException("INPUT_CHANGED_DURING_PARSE");
      } catch(Throwable fail){if(candidate!=null)try{call(candidate,"S","void",new String[0]);}catch(Throwable ignored){}throw fail instanceof Exception?(Exception)fail:new RuntimeException(fail);}
      final Object next=candidate;field(next.getClass(),"S","boolean").set(next,oldView.get("animate"));final Map<String,Object> expectedModel=model(next);
      final Map<String,Object> recovery;
      try{recovery=backup(old,before,p.getProperty("id"));}catch(Throwable failure){try{call(next,"S","void",new String[0]);}catch(Throwable ignored){}throw failure instanceof Exception?(Exception)failure:new RuntimeException(failure);}
      operationPending=true;
      final NativeTask rollback=new NativeTask(){public void run()throws Exception {
        install(old,Paths.get((String)before.get("projectPath")));
        post(new NativeTask(){public void run()throws Exception {final List<Object> missing=restoreView(oldView);final long rendered=frameCounter();afterFrames(rendered,System.currentTimeMillis(),new NativeTask(){public void run()throws Exception {restoreCamera(oldView);operationPending=false;Map<String,Object> after=snapshot();result[0].put("recoverySnapshot",recovery);result[0].put("rollback",map("verified",((Map<?,?>)before.get("model")).get("sha256").equals(((Map<?,?>)after.get("model")).get("sha256")),"status",after,"viewFallbacks",missing,"nativeFramesAdvanced",frameCounter()-rendered));try{call(next,"S","void",new String[0]);}catch(Throwable ignored){}done.countDown();}},result,done);}},result,done);
      }};
      try {
        install(next,input);
        post(new NativeTask(){public void run()throws Exception {
          try {
            // A real user edit between native queue callbacks must be preserved.
            if(project()!=next||!clean()){operationPending=false;result[0]=map("ok",false,"error","EDITOR_CHANGED_AFTER_LOAD","committed",project()==next,"status",snapshot());done.countDown();return;}
            final List<Object> missing=restoreView(oldView);final long rendered=frameCounter();
            afterFrames(rendered,System.currentTimeMillis(),new NativeTask(){public void run()throws Exception {
            try {
            if(project()!=next||!clean()){operationPending=false;result[0]=map("ok",false,"committed",project()==next,"error","EDITOR_CHANGED_DURING_REPAINT","status",snapshot());done.countDown();return;}
            boolean inputChanged=inputRevision.get()!=inputBefore;
            if(!inputChanged)restoreCamera(oldView);else missing.add(map("reason","user_input_during_reload","cameraRestoreSkipped",true));
            operationPending=false;Map<String,Object> after=snapshot();
            if(!expectedModel.get("sha256").equals(((Map<?,?>)after.get("model")).get("sha256")))throw new IllegalStateException("Native model verification failed.");
            if(!clean())throw new IllegalStateException("Native reload unexpectedly dirtied the project.");
            result[0]=map("ok",true,"committed",true,"nativeModelVerified",true,"sourceSha256",p.getProperty("sha256"),"before",before,"status",after,"viewFallbacks",missing,"undoHistoryReset",true,"recoverySnapshot",recovery,"nativeFramesAdvanced",frameCounter()-rendered);
            try{call(old,"S","void",new String[0]);}catch(Throwable cleanup){result[0].put("cleanupWarning",String.valueOf(cause(cleanup)));}done.countDown();
            }catch(Throwable fail){result[0]=map("ok",false,"error",String.valueOf(cause(fail)),"committed",false);rollback.run();}
            }},result,done);
          }catch(Throwable fail){result[0]=map("ok",false,"error",String.valueOf(cause(fail)),"committed",false);rollback.run();}
        }},result,done);
      }catch(Throwable fail){result[0]=map("ok",false,"error",String.valueOf(cause(fail)),"committed",false);rollback.run();}
    }},result,done);
    // The transport returns a durable pending ID while this worker waits. A slow
    // native queue must never turn a retry into a second application.
    done.await();
    return result[0];
  }
}
