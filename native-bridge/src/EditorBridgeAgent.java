import java.io.*;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Startup agent only: fixed commands, authenticated local files, no attach API. */
public final class EditorBridgeAgent {
  static final String TARGET_SHA256="4a1f51fa672fcffe251e10de6bb9399b0aec6564da0161f0a48aafa45681eaf8";
  static final String PROTOCOL="1";
  static final int MAX_ENVELOPE=96*1024;
  final Path root,workspace;
  final String id,secret;
  final NativeEditorAccess access;
  final Properties config;
  boolean loadedBuildVerified;
  EditorBridgeAgent(Path folder,Instrumentation inst)throws Exception {
    root=folder.toRealPath();config=properties(root.resolve("config.properties"),64*1024);
    id=config.getProperty("instanceId");secret=config.getProperty("secret");
    if(id==null||!id.matches("[0-9a-f-]{36}")||secret==null||!secret.matches("[0-9a-f]{64}")||!PROTOCOL.equals(config.getProperty("protocol")))throw new IllegalArgumentException("Invalid bridge configuration.");
    workspace=Paths.get(config.getProperty("workspace")).toRealPath();
    if(!root.startsWith(workspace))throw new IllegalArgumentException("Instance directory is outside workspace.");
    Path installed=Paths.get(config.getProperty("targetJar")).toRealPath();
    if(!NativeEditorAccess.hash(installed).equals(TARGET_SHA256))throw new IllegalStateException("Unsupported Spine build; no native access enabled.");
    Path ownJar=Paths.get(EditorBridgeAgent.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();
    if(!NativeEditorAccess.hash(ownJar).equals(config.getProperty("agentSha256")))throw new IllegalStateException("Startup agent integrity check failed.");
    // A separate process may not reuse a live or crashed instance identity.
    Files.write(root.resolve("agent-started.claim"),id.getBytes(StandardCharsets.UTF_8),StandardOpenOption.CREATE_NEW);
    Files.createDirectories(root.resolve("requests"));Files.createDirectories(root.resolve("responses"));Files.createDirectories(root.resolve("journal"));
    access=new NativeEditorAccess(inst,id,root.resolve("recovery"));
    try {
      java.awt.Toolkit.getDefaultToolkit().addAWTEventListener(new java.awt.event.AWTEventListener(){public void eventDispatched(java.awt.AWTEvent e){int event=e.getID();if(event==java.awt.event.KeyEvent.KEY_PRESSED||event==java.awt.event.MouseEvent.MOUSE_PRESSED||event==java.awt.event.MouseEvent.MOUSE_DRAGGED||event==java.awt.event.MouseEvent.MOUSE_WHEEL)access.inputRevision.incrementAndGet();}},java.awt.AWTEvent.KEY_EVENT_MASK|java.awt.AWTEvent.MOUSE_EVENT_MASK|java.awt.AWTEvent.MOUSE_MOTION_EVENT_MASK|java.awt.AWTEvent.MOUSE_WHEEL_EVENT_MASK);
      access.nativeInputTracking=true;
    }catch(Throwable unavailable){access.nativeInputTracking=false;}
  }
  static Properties properties(Path p,int budget)throws Exception {if(!Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS)||Files.size(p)>budget)throw new IOException("Invalid bridge record.");Properties v=new Properties();try(Reader r=Files.newBufferedReader(p,StandardCharsets.UTF_8)){v.load(r);}return v;}
  String mac(String data)throws Exception {Mac m=Mac.getInstance("HmacSHA256");m.init(new SecretKeySpec(secret.getBytes(StandardCharsets.US_ASCII),"HmacSHA256"));return NativeEditorAccess.hex(m.doFinal(data.getBytes(StandardCharsets.UTF_8)));}
  static void atomic(Path path,byte[] bytes)throws Exception {
    Path tmp=path.resolveSibling(path.getFileName()+"."+UUID.randomUUID()+".tmp");Files.write(tmp,bytes,StandardOpenOption.CREATE_NEW);
    try{Files.move(tmp,path,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}catch(AtomicMoveNotSupportedException e){Files.move(tmp,path,StandardCopyOption.REPLACE_EXISTING);}
  }
  void response(String requestId,Map<String,Object> value)throws Exception {
    value.put("requestId",requestId);value.put("instanceId",id);value.put("protocol",PROTOCOL);value.put("completedAt",System.currentTimeMillis());
    String body=Base64.getEncoder().encodeToString(NativeEditorAccess.json(value).getBytes(StandardCharsets.UTF_8));
    if(body.length()>8*1024*1024)throw new IOException("Native response exceeds 8 MiB.");
    String envelope="body="+body+"\nsignature="+mac("response\n"+requestId+"\n"+body)+"\n";
    atomic(root.resolve("responses").resolve(requestId+".properties"),envelope.getBytes(StandardCharsets.US_ASCII));
  }
  void request(Path request)throws Exception {
    String filename=request.getFileName().toString(),requestId=filename.substring(0,filename.length()-11);
    if(!requestId.matches("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"))return;
    if(Files.exists(root.resolve("responses").resolve(requestId+".properties")))return;
    Properties env=properties(request,MAX_ENVELOPE);String body=env.getProperty("body"),sig=env.getProperty("signature","");
    if(body==null||!MessageDigest.isEqual(mac("request\n"+requestId+"\n"+body).getBytes(StandardCharsets.US_ASCII),sig.getBytes(StandardCharsets.US_ASCII)))return;
    byte[] decoded=Base64.getDecoder().decode(body);if(decoded.length>48*1024)return;
    Properties encoded=new Properties();encoded.load(new StringReader(new String(decoded,StandardCharsets.US_ASCII)));Properties p=new Properties();
    for(String key:encoded.stringPropertyNames())p.setProperty(key,new String(Base64.getDecoder().decode(encoded.getProperty(key)),StandardCharsets.UTF_8));
    if(!requestId.equals(p.getProperty("id"))||!id.equals(p.getProperty("instanceId")))return;
    Set<String> keys=new HashSet<String>(Arrays.asList("id","instanceId","action","issuedAt","deadline","input","sha256","expected.instanceId","expected.projectPath","expected.projectIdentity","expected.undoToken","expected.modelSha256"));
    if(!keys.containsAll(p.stringPropertyNames())){response(requestId,NativeEditorAccess.map("ok",false,"error","Unsupported request property."));return;}
    Path journal=root.resolve("journal").resolve(requestId+".started");
    try{Files.write(journal,NativeEditorAccess.hash(decoded).getBytes(StandardCharsets.US_ASCII),StandardOpenOption.CREATE_NEW);}catch(FileAlreadyExistsException e){return;}
    try {
      long now=System.currentTimeMillis(),issued=Long.parseLong(p.getProperty("issuedAt")),deadline=Long.parseLong(p.getProperty("deadline"));
      if(issued>now+5000||deadline<now||deadline-issued>60000||deadline<=issued)throw new IllegalStateException("REQUEST_EXPIRED: no native changes were made.");
      if(!loadedBuildVerified){Path loaded=Paths.get(access.type("s.QxC").getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();if(!NativeEditorAccess.hash(loaded).equals(TARGET_SHA256))throw new IllegalStateException("Loaded native classes do not match the supported build.");loadedBuildVerified=true;}
      if("reload".equals(p.getProperty("action"))){Path input=Paths.get(p.getProperty("input")).toRealPath(),current=Paths.get(p.getProperty("expected.projectPath")).toRealPath();if(!input.startsWith(workspace)||!current.startsWith(workspace))throw new IllegalArgumentException("Project is outside workspace.");}
      response(requestId,access.execute(p));
    }catch(Throwable e){Throwable c=NativeEditorAccess.cause(e);response(requestId,NativeEditorAccess.map("ok",false,"error",c.getClass().getName()+": "+c.getMessage()));}
  }
  void heartbeat()throws Exception {
    String pid=ManagementFactory.getRuntimeMXBean().getName().split("@")[0];
    atomic(root.resolve("agent.json"),NativeEditorAccess.json(NativeEditorAccess.map("protocol",PROTOCOL,"instanceId",id,"pid",Long.parseLong(pid),"targetVersion","4.3.23","targetJarSha256",TARGET_SHA256,"heartbeatAt",System.currentTimeMillis(),"operationPending",access.operationPending,"inputInjectionUsed",false,"bytecodeTransformed",false)).getBytes(StandardCharsets.UTF_8));
  }
  void loop()throws Exception {
    Thread heartbeat=new Thread(new Runnable(){public void run(){for(;;){try{heartbeat();Thread.sleep(1500);}catch(Throwable ignored){try{Thread.sleep(2000);}catch(InterruptedException stop){return;}}}}},"Spine-MCP-heartbeat");heartbeat.setDaemon(true);heartbeat.start();
    for(;;){try(DirectoryStream<Path> stream=Files.newDirectoryStream(root.resolve("requests"),"*.properties")){for(Path p:stream)try{request(p);}catch(Throwable ignored){}}Thread.sleep(100);}
  }
  public static void premain(final String folder,final Instrumentation inst) {
    if(folder==null||!folder.startsWith("b64:"))return;
    final String decodedFolder=new String(Base64.getUrlDecoder().decode(folder.substring(4)),StandardCharsets.UTF_8);
    Thread worker=new Thread(new Runnable(){public void run(){try{new EditorBridgeAgent(Paths.get(decodedFolder),inst).loop();}catch(Throwable failure){try{atomic(Paths.get(decodedFolder).resolve("startup-error.json"),NativeEditorAccess.json(NativeEditorAccess.map("ok",false,"error",String.valueOf(NativeEditorAccess.cause(failure)))).getBytes(StandardCharsets.UTF_8));}catch(Throwable ignored){}}}},"Spine-MCP-file-RPC");worker.setDaemon(true);worker.start();
  }
}
