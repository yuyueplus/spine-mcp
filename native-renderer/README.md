# Spine bgfx 直播渲染 worker

使用 **Go + cgo + Spine 官方 C++ 4.3 运行时 + bgfx**。Go 管理动作、帧时钟、控制请求和 FFmpeg；C++ 只负责 Spine/bgfx 的 C ABI 适配。没有 Node.js 或浏览器运行依赖。

渲染 worker 与业务主服务分进程运行。cgo 会执行原生代码，显卡驱动或原生库崩溃仍可能结束 worker；业务服务应监控 worker 的退出状态并按业务策略重建。

## 当前能力

- 在无窗口帧缓冲中渲染 Spine 4.3 `.skel` / `.json`、多页图集、普通和加权网格、裁剪。
- 普通、叠加、正片叠底、滤色混合；直通/PMA 图集；双色染色。
- 切换动作及混合、循环、暂停/继续、播放速度、位置和缩放、皮肤、指定时间。
- 固定帧率或不限速运行；RGBA 图片读回；4x MSAA 或关闭 MSAA。
- FFmpeg 软件 H.264 输出本地 MPEG-TS / MP4，或显式配置的 SRT 地址。默认不会连接任何远程服务。
- 有界控制队列、Go OS 线程固定、C ABI 线程归属检查、进程退出和编码结果校验。

当前0.2.0支持 GPU NV12 转换、CPU 读回后软件/NVENC/AMF 编码及本地音轨混合；GPU 编码零拷贝尚未实现。图集暂接受 Linear/Nearest 基础过滤；需要 mipmap 的图集会明确报错。`seek` 会重置物理状态，不等价于逐帧重演任意物理动画。

## 构建

Go 1.23+、cgo C 编译器、Git、CMake 3.21+、C++20 编译器。依赖使用 `dependencies.json` 中的具体提交，不跟随上游分支。首次会下载源码并编译着色器工具，耗时明显长于增量构建。

Windows：安装 Visual Studio 2022 的 C++ 桌面工具和 Windows SDK，同时准备供 cgo 使用的 MinGW-w64 GCC。本项目的 C ABI DLL 使用 MSVC；Go 的 C 桥使用 GCC，避免把 C++ 类型或内存分配器跨编译器传递。

```powershell
.\build.ps1
# 复用本机已有依赖缓存时：
.\build.ps1 -Cache ..\work\bgfx-source
```

脚本只在子任务期间选择 Windows/amd64 和 CGO_ENABLED=1，退出后恢复环境变量。DLL 使用静态 MSVC CRT；部署不需要安装 Visual Studio。

Linux / macOS：在目标系统执行，不以设置 GOOS 代替完整的 cgo 交叉工具链。

```sh
sh ./build.sh
```

Linux 构建需要 C++ 编译器及 X11/OpenGL 开发包，例如 Debian/Ubuntu 的 `build-essential cmake git libx11-dev libgl1-mesa-dev`。实际渲染还需要可用的 Vulkan 驱动和 GPU。macOS 需要 Xcode Command Line Tools。

默认后端：Windows D3D12、Linux Vulkan、macOS Metal。可显式选择 `d3d11`、`opengl` 等后端。程序记录实际后端、GPU vendor/device ID，初始化失败会报错，默认拒绝无法确认的硬件/软件适配器。

构建脚本覆盖三个系统。Windows AMD 与 Linux NVIDIA 已分别执行真实 GPU 验证；Linux 主机进程模式与 GPU 隔离容器的结果分开记录，详见下方实机记录。macOS 仍需目标机器 GPU 验收。CI 的非 GPU 回归不代替真实显卡验收。

## 运行

将导出的 skeleton.skel、skeleton.atlas 和所有图集 PNG 放入 `examples/assets/`，或者编辑配置中的路径。相对资源路径以配置文件所在目录为基准。原始 `.spine` 工程不会被修改。

```powershell
.\build\bin\Release\spine-worker.exe -config examples/session.json -output output/demo.mp4 -report output/report.json
```

需要 PATH 中有 `ffmpeg` 和 `ffprobe`，也可以通过 `-ffmpeg`、`-ffprobe` 指定路径。已有输出默认拒绝覆盖，必要时明确传入 `-overwrite`。

只有传入 SRT 地址才会推流，例如：

```sh
spine-worker -config session.json -output 'srt://YOUR_HOST:9000?mode=caller&pkt_size=1316'
```

这不会自动接入 EEAI 的鉴权、路由和会话管理。接入时由现有 Go 服务启动 worker，传入该服务生成的地址；不要启动带有远程数据库写入的业务程序做本地渲染验收。

## 指定结果出球演示（prototype-6）

新增 `cmd/lottery-demo`：在本机输入六个正码及一个特码，生成117秒、1280×720、30fps的 Spine 场景，并由原生 GPU worker 输出 SRT，经本机 FFmpeg 转为 HLS 和 MP4。页面只播放服务器编码的视频。首版使用49种号码、每种24帧的球面旋转素材；左侧特写、主球机、颜色和离线中文报号绑定同一组结果。它是明确标识的指定结果演示，没有接入原站账户、投注或结算。

第2版将球面改为12个小圆号码贴纸、较窄的粗体字、不同停留朝向和较小的高光；底部改为49球/42球两套预先计算的重力接触姿态，补齐前后遮挡、接触阴影及玻璃后的明暗。出球前后分别使用对应球数的球堆，不再保留规则行列。球堆姿态由离线球体接触求解后投影得到，搅拌阶段仍使用预设轨迹。

第3版使用官方 Box2D3.1.1 计算左侧轨道的下落、轨道接触、球间碰撞、摩擦、滚动阻力及停稳；以120Hz、每步4个子步求解，60Hz姿态烘焙为 Spine 位置和旋转关键帧。落地时不会把球强行移动到预设终点，球堆在后续球落入时也保持动态。特码按参考片从右侧进入独立托盘，和左侧六球使用分开的碰撞层。系统只调整放球闸门时间以匹配节目节奏，号码绑定独立于物理几何。特码显示、报号时间采用其实际停稳时间；主球舱搅拌及小视图出舱过渡仍含预设轨迹。

Box2D 源码固定在 `internal/trackphysics/box2d/SOURCE.json` 所列的官方提交 `8c661469c9507d3ad6fbd2fea3f1aa71669c2fe3`，许可证为 MIT，原许可保留于同目录。通过 cgo 静态编译进演示服务，不新增动态库或运行时下载。构建这项演示需要支持 C17 的 cgo 编译器。生成目录中的 `physics.json` 记录引擎版本、步长、放球时间及最终物理姿态，并和场景一起校验。官方说明：[Box2D3.1.1](https://github.com/erincatto/box2d/releases/tag/v3.1.1)、[滚动阻力](https://box2d.org/posts/2025/04/box2d-3.1/)。

第4版修正主画面的出球机构：所选球先进入中央漏斗口，经竖直吸管上升、顶部弯头，正码再进入左侧外轨；特码经同一吸管后转入右侧支路。小画面和主画面绑定同一个物理出球时钟，移除从球舱直接斜飞到左右结果位的捷径。吸送阶段采用位置连续的导管约束运动，左侧滚落仍由 Box2D 计算，没有声称做完整流体模拟。管壁、漏斗前沿和顶部盖板使用未修改底图的局部 UV 网格恢复遮挡。未选球的混动范围集中在漏斗下方；球面、静态球堆和输入号码规则不变。

第5版把物理世界直接标定到主画面轨道的像素坐标，取消主画面和放大窗各自的位置曲线及球径变化。左侧放大窗和独立特码窗分别以4.05倍、4.75倍等比取景；轨道背景使用同一区域的 UV 网格，球的位置、大小、转角、颜色和贴图序列来自主画面已序列化的同一组关键帧，插值时刻也一致。放大窗重新以较高分辨率绘制球面，因此清晰度与把已编码的小球直接放大不同。当前 Box2D 配置为120Hz、每步16个子步，60Hz烘焙，入栈前以平滑阻尼模拟气动缓冲；球仍通过物理接触停稳。测试覆盖117秒全部3510个视频时刻、七个球的跨视图位置、球径及转角，并核对颜色、可见性和贴图序列。这里验证的是共享姿态数据，不能把它解释成编码后逐像素相同。

第6版重新标定顶部外轨的下方承托面：上弯轨按底图内沿拟合，物理球心沿承托面法线偏移球半径，修正旧碰撞轨道靠近上沿造成的可见悬空间隙。出口位置直接读取同一物理入口，导管弯头同时匹配入口切向速度；入轨初速为95像素/秒，并给出相应滚动角速度。下落与接触仍由 Box2D 求解，没有将每帧球位强行贴到曲线上。新增检查测量七个球在顶部弯轨的逐采样承托间隙，同时保留跨视图同步、碰撞、停稳和完整视频验收。

本轮素材位于仓库的 `work/lottery-demo-v2/assets-final`。构建并运行（在 native-renderer 目录内）：

```powershell
$env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='1'
go build -o build/bin/Release/lottery-demo.exe ./cmd/lottery-demo
.\build\bin\Release\lottery-demo.exe -root .. -assets ../work/lottery-demo-v2/assets-final -state ../work/lottery-demo-v6/run-local -binary build/bin/Release -listen 127.0.0.1:8090 -ttl 2h
```

FFmpeg/FFprobe需在 PATH，或通过同名参数指定绝对路径。打开输出的本机地址，设置七个不同的1–49整数后点击“生成并播放”。每轮结果提交后锁定；重复 requestId 返回原任务，冲突和同时提交第二轮返回409。停止会先等待本任务进程清理，再释放下一轮。服务重启将旧活动任务标记为 interrupted，不重复播出。单目录最多保留16轮；服务寿命可配置1分钟至24小时，默认2小时。

`POST /api/rounds` 接受 `mode:"scripted_demo"`、`roundId`、`requestId`、`regularNumbers:[...]`、`specialNumber`。写请求需要页面注入的 `X-Demo-Key`；服务只接受127.0.0.1的 Host。`GET /api/rounds` 返回状态及媒体地址。完整回放通过3510帧解码和尺寸检查后才开放。`POST /api/rounds/{id}/stop` 停止本任务。

素材构建工具为 `examples/lottery-demo/build_assets.py` 和 `build_voices.ps1`。前者需要 Python、NumPy、Pillow、一个已清理的空场底图、已核验规则 JSON 和98个预生成报号 WAV；后者在 Windows 使用本机中文 SAPI 声音静默生成 WAV。先执行 `build_voices.ps1 -Output NEW_VOICES`，再执行 `python build_assets.py --plate PLATE.png --rules RULES.json --voices NEW_VOICES --output NEW_ASSETS`；输出目录必须未封存。默认球面字体为本机 Impact，可用 `--font` 指定其它字体文件；运行服务只读取生成好的图片，不需要字体或 Python。播放器固定为 hls.js1.6.13，下载时验证 SHA-512，运行时不下载依赖，也不调用图像或语音服务。

演示实测平台为 Windows AMD/Vulkan；它使用有立体感的球面序列和2D物理轨道，未实现完整三维玻璃折射、主球舱实时三维碰撞、写实主持人、动态口型及24小时无缝连续节目。参考片机位和出球节奏为近似复现，并非逐像素一致。Linux/macOS需要单独构建和实测；本机通过不代表跨平台已验收。

独立 Chrome 验收脚本：`node examples/lottery-demo/verify_browser.mjs http://127.0.0.1:8090/ NEW_EVIDENCE_DIR`。它使用新的浏览器配置和空演示状态，完成参考号码、特码49的两轮真实直播、回放及停止检查，不操作用户已有 Chrome 标签。

追加 `reference` 参数可只检查一轮参考号码及停止清理，追加 `startup` 则检查已有完整回放在页面重载后的恢复。完整播放验证同时保存70秒结果画面及52秒主轨道/放大窗的对照截图。端口可通过命令行指定，验收脚本 URL 应与实际服务一致。

## 控制

传入 `-control-stdin` 后，父进程通过 stdin 管道发送每行一个 JSON 请求。stdout 输出 ready、response、progress、complete/error JSON；每个 response 带有应用命令时的帧号。每 300 帧发一次 progress。ready 只表示资源和 GPU 就绪，不代表 SRT 已连通或观众已看到。父进程应持续读取 stdout 和 stderr，避免管道反压。

```json
{"id":1,"method":"play","params":{"animation":"walk","loop":true,"mix":0.2}}
{"id":2,"method":"pause"}
{"id":3,"method":"transform","params":{"x":700,"y":650,"scale":1.2}}
{"id":4,"method":"speed","params":{"value":0.5}}
{"id":5,"method":"skin","params":{"name":"default"}}
{"id":6,"method":"seek","params":{"time":1.0}}
{"id":7,"method":"resume"}
{"id":8,"method":"status"}
{"id":9,"method":"shutdown"}
```

`frames: 0` 表示持续运行，要求配置输出。命令在帧边界执行；暂停后仍按帧率输出当前姿势。错误命令返回 error，后续渲染继续。持续会话遇到 stdin EOF 会排队停止，保证此前命令先得到处理；首帧之前停止时不会启动编码器或生成空视频。

也可在 Go 中调用 `worker.Run`，通过 `Options.Requests` 传命令。一个进程只允许一个 bgfx 实例；多房间先用多个 worker，容量需实测。Run 内部锁定 OS 线程并串行调用原生接口。底层 `internal/native` 的帧像素由 C++ 持有，仅在下一次 Step/Close 之前有效；需要异步留存时先复制。OnFrame 回调返回前必须完成消费。

## 验证和交付

```powershell
$env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='1'
go test ./...
go vet ./...
# 开启真实显卡测试，包括混合、PMA、双色、裁剪、加权网格和线程归属：
$env:SBGFX_TEST_LIBRARY=(Resolve-Path build/bin/Release/spine-bgfx.dll).Path
go test -count=1 -v ./internal/native
# 用五动作角色做性能、持续运行、画面参考和本机 SRT 验收：
go run ./cmd/acceptance -source PATH_TO_RUNTIME -references PATH_TO_REFERENCE_PNGS
```

acceptance 的素材需包含五个既定测试动作，参考帧为官方 CanvasKit 生成的 45/135/225/315/405 帧。`-srt-loopback` 只连接 127.0.0.1。每次保存实际帧数、编码解码帧数、耗时分位数和原始资源 SHA-256；总吞吐包含初始化、编码收尾及验证，renderWallMs 对应持续帧生成/交付阶段。

部署包由 `go run ./cmd/package` 生成，包含 worker、原生库、各后端着色器、固定依赖清单和许可证。FFmpeg、角色资源和用户配置由部署环境提供。原生库按目标 OS/CPU 构建，不能把 Windows DLL 直接复制到 Linux 使用。

bgfx 为 BSD-2-Clause，JSON 库为 MIT；Spine 运行时遵守独立的 Spine Runtimes License Agreement。包中包含上游许可与第三方声明；商用发布还需核对 Spine 授权、编译器运行库以及实际使用的 FFmpeg 构建。本机测试使用已安装的 FFmpeg，没有把该二进制打入部署包。

官方参考：[bgfx](https://bkaradzic.github.io/bgfx/overview.html)、[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes)、[cgo 指针规则](https://pkg.go.dev/cmd/cgo#hdr-Passing_pointers)、[LockOSThread](https://pkg.go.dev/runtime#LockOSThread)。


## 0.2.0 直播配置与调度

`worker.Config` 新增 pixelFormat（rgba/nv12）、encoder（codec/bitrateKbps/device）、audio（最多8个本地file/gain/loop/offsetMs）、queueFrames（0–8）和 verification（full/packets）。NV12 要求宽度是4的倍数、高度为偶数；输出为 BT.709 limited，GPU 打包后每帧为 width*height*1.5 字节。queueFrames>0 时复制到有界 Go 缓冲区后交给编码线程，原生帧存储不跨 Step 保留。

硬件编码器 h264_nvenc/h264_amf 会先做真实一帧编码。libx264 保持默认兼容路径；选硬件失败不自动降级。音频统一为48kHz立体声 AAC，支持循环、增益、静音补齐和毫秒偏移；实际文件核对编码格式、时长及起始音画误差。音频不是由骨骼事件实时驱动的语音合成或自动口型。

`spine-roomd -config HUB.json -state PRIVATE_SERVER.json` 监听随机 loopback 端口，以私有 token 认证。信任配置指定 root、directory、worker、library、ffmpeg、ffprobe、slots 和 queueLimit。MCP 可通过 nativeRenderer 配置自动启动此服务。每个房间固定 GPU 槽位，按 capacity/memoryMB 预留并限流，至多三次重试、48小时租期、1024条历史。素材和配置改变阻止重试。重连不重复启动相同房间；服务进程重启后的旧活动记录标为 interrupted，不假称原流仍然播放。

本地槽位只允许一个物理 GPU 声明；多个 GPU 槽位必须各有 dockerGpu（完整 GPU UUID）和 dockerImage。调度器使用 Docker 的 --gpus device=UUID，挂载 graphics/video/compute/utility 驱动能力；图形和编码都在该容器中执行。真实多卡隔离/性能仍需在目标 NVIDIA 主机验收。memoryMB 是准入预留预算，不是 NVML 的实际显存测量。

停止时优先发送 shutdown，让编码器收尾；超过宽限期则取消所拥有的进程树。Windows 使用 Job Object，Unix 使用进程组；不会关闭其它编辑器、任意 FFmpeg 或用户进程。受理、ready、控制排队、appliedAtFrame 和观众收到画面是不同证据。

完整包包括 spine-worker、spine-roomd、spine-soak、原生库、着色器和许可。Linux 先运行 build.sh，再从 native-renderer 目录构建 Dockerfile；Windows DLL 不能用于 Linux。FFmpeg 不随 ZIP 分发，由部署环境安装；上游 Spine 和第三方许可继续适用。

Linux NVIDIA 验收：

```bash
bash scripts/accept-gpu.sh /srv/spine/session.json /srv/spine/hub.json 4 86400 /srv/spine/results/run-001
```

上述脚本先实际测试 GPU 转换和音频、编码/解码60帧，再运行多房间24小时验收，默认要求硬件编码。长跑用 encoded_packets 核对所有编码包，避免将整天视频软件解码耗时混入直播性能；它不声称完整逐帧解码。短片解码和 GPU 色彩对照证据另行保存。验收会检查全部房间成功、实际帧数、P95 帧处理时间和最大超期比例。self-hosted nvidia-gpu workflow 可手动运行；没有目标服务器时不能标记 Linux/NVENC/多卡/24小时为已通过。

本轮 Windows RX550 实测：Vulkan/D3D12 的 GPU NV12 与 CPU 颜色参考核对通过；AMD AMF 单路编码及90帧带 AAC 音频的 SRT 回环通过；双房间软件编码短跑通过。两路 AMF 同时初始化失败（驱动返回 encoder Init error36），因此默认一路并发；不把单路结果换算为并发承诺。NVIDIA NVENC 在该 AMD 主机上明确报告缺少 nvcuda.dll。

SRT 未指定时补充 linger=2 与 pkt_size=1316，显式参数保留。修复短流结束时发送缓冲区尚未排空就关闭的问题。房间使用 stop-on-control-eof：管理进程丢失时，即使是有限帧任务也会关闭。Linux 容器按 CID 和精确所有权标签停止；无法确认容器停止时标记 cleanup_failed 并隔离该 GPU 槽位，可再次调用停止重试清理，不会把未知状态报告为已停止。


## Linux 实机记录（2026-11-06）

共享测试机为 Ubuntu 22.04、RTX 4070 Ti SUPER、NVIDIA 580.82.09。原生库在 Ubuntu 24.04 容器中使用 Go 1.23.3 / GCC 13.3 构建；完整编码链路在宿主机的独立测试进程中执行，使用测试目录中的私有运行库和 FFmpeg 6.1.1。这个目录启动方式用于兼容验证；常规原生部署应在匹配的 Linux 发行版上构建，或使用经过实际编码探测的容器环境。

已通过 Vulkan 混合/PMA、裁剪、加权网格、双色染色、GPU NV12 颜色对照、控制命令、音频混合、race 和 cgocheck2。NVENC 单路 1080p 短测完整编码/解码600帧，4K短测300帧；带 AAC 48kHz立体声音频的 SRT 宿主机回环收到并解码90帧。四路1080p60的一分钟并发测试每路编码3600帧，P95帧处理约1.9–2.5ms，存在少量超期帧；短测结果不能换算为长期容量承诺。

该机器在仅传入4070的容器中，CUDA/Vulkan可用，NVENC初始化报 `OpenEncodeSessionEx: unsupported device`；同一设备的宿主机进程编码通过。这个现象与 [NVIDIA已记录的多卡容器问题](https://github.com/NVIDIA/nvidia-container-toolkit/issues/1249) 一致，具体驱动根因未独立确认。GPU隔离容器的硬件编码仍为未通过项；本轮没有修改主机驱动或现有服务。其它物理GPU未参与渲染验收，24小时长稳也未完成。

worker会先用256×256帧做真实编码探测，避免部分NVENC设备拒绝64×64测试帧而被误判为不可用。可在worker JSON中配置 `gpuVendorId` / `gpuDeviceId`（PCI vendor/device ID，16位整数）选择渲染适配器；指定device时需要同时指定vendor，初始化后会核对实际ID。相同型号的多卡不能靠这两个ID区分；物理GPU隔离继续依赖经验证的容器UUID方案。NVENC设备选择还需与该进程的CUDA可见设备匹配。

音频链路需要FFmpeg支持 `alimiter` 的 `latency` 选项。测试机原有FFmpeg4.4.2缺少此选项，独立FFmpeg6.1.1验证通过；本轮没有升级主机FFmpeg。


双路1080p30持续十分钟验收已完成，每路编码18000帧，超期帧数均为0，P95帧处理约1.7ms。单路4K60的一分钟验收编码3600帧，P95约3.3ms。这些数据使用本项目当前40骨骼、11插槽、12页图集的五动作角色；完整编码包计数与短片完整解码分开记录。

Linux NVIDIA 的精简运行环境还需 `libegl1`：该驱动在无窗口Vulkan初始化时也会加载EGL。本轮发现缺少此库会导致初始化失败，补齐后对照启动通过；项目Dockerfile已加入它。运行环境应具备 `libvulkan1 libx11-6 libgl1 libegl1 libstdc++6`、可用GPU驱动及满足音频滤镜要求的FFmpeg/FFprobe。可用 `VK_LOADER_DEBUG=error` 辅助定位Vulkan驱动加载问题。


## 本机浏览器直播示例

`examples/browser-live.py` 提供 SRT 接收、HLS 分片、本机观看页和到期停止。需要 Python 3.11+、可用 FFmpeg，以及已配置的 MCP 原生渲染服务。播放器首次使用时下载固定的 HLS.js 1.6.13，并核对 SHA512；也可预先将 `hls.min.js` 和许可证放入运行目录的 `web/`。浏览器优先使用 HLS.js/MSE，缺少MSE时再尝试原生HLS。它只监听127.0.0.1。

1. 复制 `examples/browser-live.json` 到自己的配置位置，调整相对路径、动作名称和新UUID。每次新直播更换roomId，并保持MCP启动请求的requestId与它一致。
2. 调用 `spine_plan_live_room`，选择自己的skeleton/atlas，输出 `srt://127.0.0.1:19000?mode=caller&latency=100000`，显式设置allowNetworkOutput=true。宽高、fps与观看页配置保持一致。先用默认libx264，硬件编码需另行核对。
3. 启动接收和观看页：

```sh
python native-renderer/examples/browser-live.py --config native-renderer/examples/browser-live.json
```

4. 看到本机观看地址后，使用计划路径和精确SHA调用 `spine_start_live_room`。接收器首次等待连接最多60秒；未连接时可在准备好启动请求后重启观看页。默认打开 `http://127.0.0.1:8088/`；端口占用时以终端和运行目录watch.json报告的地址为准。

配置durationSeconds控制观看页持续时间，MCP计划的leaseSeconds应与它匹配。页面“结束本机直播”只停止配置的房间及本接收器；暂停video仅暂停观看。手动中断示例程序也会请求停止该房间。自动切换动作仅使用clips中的明确名称；未提供的素材不会被生成。示例中idle/wave是占位名称，请替换为工程实际动作。

Windows RX550 上已复现并修正 AMF 每2秒关键帧出现的衣裙马赛克：旧 `ultralowlatency` 模式限制单帧编码预算，改为 `lowlatency`，保持 CBR 目标码率、2秒 VBV 和无B帧。相同720p静态角色、3.5Mbps、240帧对照中，衣裙区域最低PSNR从21.92dB提升到41.69dB，最大相邻帧RGB变化从11.49/255降到0.53/255。该模式允许关键帧短时使用更多码率；不同GPU、素材及接收端仍需实测。

观看页先将HLS文件读为内存快照，关闭句柄后再发送给浏览器，避免慢请求长期阻止FFmpeg替换播放列表；Windows文件句柄允许delete共享，便于清理旧分片。文件读入内存的短暂期间仍可能与Windows的替换操作竞争。复制部署时保留 `browser-live.py` 同目录下的 `hls_snapshot.py`；原生压缩包包含这两个脚本及配置示例。可运行 `python -m unittest discover -s native-renderer/examples -p test_hls_snapshot.py -v` 验证慢请求期间的播放列表替换和打开分片的删除；设置 `SBGFX_TEST_FFMPEG`、`SBGFX_TEST_HARDWARE_ENCODER=h264_amf` 后运行Go测试，可在实际AMD编码器上核对静止纹理跨关键帧的稳定性。数值回归与最终观看反馈分别记录。


## 通用物理与持久化验收（MCP 3.3.0）

部署包增加 `spine-physics`，使用随源码固定的官方 Box2D3.1.1（见 `internal/trackphysics/box2d/SOURCE.json`）。独立JSON CLI支持动态圆、静态胶囊折线、重力、摩擦、弹性、碰撞过滤、延迟激活和固定步进。`spine-physics -probe` 查询协议；`-input scene.json -output NEW.json` 只创建新输出。许可证随包放在 `licenses/Box2D-LICENSE`，上游源码及其哈希清单不作应用级修改。

MCP使用 `spine_plan_physics_bake` 固定源工程、资源和求解器哈希，再通过 `spine_bake_physics_animation` 输出新动作候选；`spine_audit_physics_contacts` 检查明确接触时段，`spine_audit_view_sync` 检查统一镜头变换。输入坐标 x向右/y向上，角度为度；轨道胶囊半径和球半径均参与接触面。轨道物理不使用屏幕插值或逐帧姿态瞬移。出生时间控制刚体激活，不控制附件透明度。

`spine_start_native_acceptance` 从当前、仅本地输出的直播计划启动独立监督进程。MCP断开后继续，`spine_get_native_acceptance` 读取实际心跳、进度和最终报告，`spine_stop_native_acceptance` 关闭该任务自己的控制管道并等待房间清理。支持1～86400秒、1～8路，需显式输出空间预算；长测不能沿用默认2GiB预算。运行中、失联、停止请求均不是验收通过。任务不会访问远程数据库或Redis。

Linux 192.168.0.30 已对3.3新增通用物理及完整Go单元测试/静态检查通过。当前 NVIDIA580.82.09 双GPU主机的单卡隔离容器NVENC仍失败：相同命令宿主机成功、单卡容器失败、全卡可见容器成功；Ubuntu22/24两组FFmpeg均复现。该组合与 [NVIDIA已记录问题](https://github.com/NVIDIA/nvidia-container-toolkit/issues/1249) 一致。全卡可见仅用于诊断，不作为隔离通过或默认部署方案；不注入第三方驱动拦截库。物理多卡渲染容量、24小时持续运行及macOS GPU仍须独立实机回执。
