# Spine 4.3.23 本地 MCP

在后台读取和修改已保存的 Spine 工程，通过 stdio 向 Codex 等 MCP 客户端提供工具。文件编辑、骨骼姿态预览、CLI 导入导出和图集打包都不使用鼠标键盘，也不激活桌面窗口。显式调用编辑器打开功能时会启动窗口，可能改变焦点。

当前版本 **3.1.0，共 229 个 MCP 工具**。涵盖工程预检、资源管理、关键帧编辑、跨工程复用、网格与蒙皮、动画质量、交付和检查点工作流。普通 JSON 编辑无需 CLI；原生工程工具通过本机 4.3.23 导入、重新导出核对后才发布新的 `.spine`。标准 MCP 客户端可按已注册的 `spine43` 启动新服务；已连接客户端可能仍持有旧进程或工具目录，需要重连。`npm run verify:registered` 验证新建连接，不表示已打开的对话已刷新。

## 从 GitHub 安装

当前验证平台为 Windows。需要 Node.js 22.2+ 和本机可用的 Spine 4.3.23；视频功能另需 FFmpeg/FFprobe，复杂 PSD 栅格化另需 Python 3.11+。本仓库不包含 Spine 编辑器或其安装包。

```powershell
git clone https://github.com/yuyueplus/spine-mcp.git
cd spine-mcp
npm ci
npm run build
npm run setup -- --output spine.local.json --workspace ./work --cli "C:/Spine/Spine.com" --gui "C:/Spine/Spine.exe"
npm run doctor
```

将 `--cli`、`--gui` 替换为该电脑实际的 Spine 入口。`setup` 输出可用于 MCP 客户端的启动参数；也可参考 `mcp.example.json` 或 `codex-mcp.example.toml`，把 `C:/path/to/spine-mcp` 替换为实际克隆目录。MCP 服务默认读取仓库根目录的 `spine.local.json`。需要复杂 PSD 功能时，安装 Python 后再运行 `npm run setup:psd-raster`；视频工具可通过 `setup --ffmpeg`、`--ffprobe` 指定。

编辑器状态和原窗口重载只支持 `native-bridge/builds.json` 中固定哈希的构建及桥接启动方式，版本号相同不代表构建兼容。普通 JSON 文件处理不需要原生桥接。

源码仓库保留测试、示例、第三方许可和自有桥接 JAR；个人配置、工作工程、依赖、编译目录及本机验收输出均不提交。`npm test` 运行单元测试；完整集成验证所需的本机工具和示例见下文“完整功能核对”。

## 3.1.0 原生编辑器状态与可编辑工程重载

新增启动桥接：`spine_open_project({input, nativeBridge:true})` 打开独立 Spine 窗口；`spine_editor_state({instanceId})` 从编辑器主线程读取完整工程路径、真正的未保存状态、骨骼/插槽/动作证明和视图状态。将回执中的 expected 字段交给 `spine_reload_editor_project`，即可将 MCP 生成的新工程载入同一个窗口，直接更新可编辑数据。统一入口 `spine_refresh_editor_view` 的 editable_in_place 模式也支持这一流程。

已验证的适用范围是 `native-bridge/builds.json` 中固定 SHA256 的本机 Spine 4.3.23 构建。普通启动的窗口需要通过 MCP 重新打开一次；其它构建会拒绝原生控制，仍可使用普通打开和文件处理功能。启动可能激活新窗口；随后重载不发送鼠标键盘输入、不调用窗口激活接口、不修改原应用字节码。它不是官方插件 API。

未保存修改、过期工程身份/撤销令牌、正在交互或显示对话框、文件损坏/漂移时均拒绝重载。应用前以原生读写器生成并验证新的同目录恢复文件；成功后保留模式、帧、动画/皮肤选择、播放按钮和镜头，丢失名称单独报告。**成功的整工程重载会重置原生撤销历史。** 断线或超时后查询同一 `spine_editor_request_status`，不重复提交新 ID。详见 [桥接说明](native-bridge/README.md)。

本阶段验收记录由 `work/native-editor-bridge-report-3.1.0.json` 和封版后的 `VERIFICATION.json` 保存。旧版验证记录保留其原适用范围，不能替代当前代码及桥接二进制的核验。

### 3.1.0 封版验证结果

最新版通过 797 项单元测试、53 组集成验证和全部 229 工具成功调用覆盖。中文/空格目录的独立安装、原生桥接启动与重载验证通过；5 类原生窗口工程覆盖 33 皮肤、物理、三骨架及原角色副本。未保存拒绝、断线去重和替换后/重绘后回滚均有独立实测记录。28 项计划在声明的有界范围内完成；普通启动窗口和其它构建不在桥接支持范围。详见发行包 VERIFICATION.json。

## 3.0.0 完整工作流与 JavaScript 交付

固定范围见 `COMPLETION-PLAN.json` 的 M1–M7、28 项。`spine_workflow_catalog` 给出加素材、完整角色、动作复用、口型、修问题和交付六个入口。`spine_product_completion_status` 逐文件核对完整源码清单，区分本安装的验证证据与过期报告。封版结果见发行包 `VERIFICATION.json`；开发中没有匹配报告时返回待验证。

素材流程为 `spine_create_material_spec` → Codex 生成本地 PNG → `spine_supply_material_assets` → `spine_place_material_assets`。规格记录完整部件、画布、锚点、重叠、补绘要求及许可；`humanoid_full` 集中报告缺失语义部件。语义来自调用方，不能自动识别图片中的人体或保证隐藏区已经画好。素材回填核对尺寸、透明背景、SHA、保护像素和资产修订；同一请求返回原回执。放置支持明确的世界或骨骼局部锚点、局部旋转/缩放、绘制顺序，并保留已有绘制顺序动画。输出共享镜头的前后图、可恢复的原始收集版本和新 JSON。发布中断后复用同一暂存输出。

`spine_extract_psd_sections` 处理明确 PSD 组及视口，允许完整角色文件的大图层树；最多 32 MiB RGB8、1024 元数据图层、256 选中图层、2MP 视口。实际来源验证使用官方 2018 年 8-direction character PSD：一份原创 PSD，689 图层，三个完整角色方向，分别导入 27/14/22 个可见组。其他方向、隐藏变化和子图层编辑保留在原 PSD；不会把一份文件说成三个独立原创。原图网格的独立合成误差仍须最大 <3/255、平均 <0.35/255；纹理抗锯齿预览另测，JSON/原生预览须逐字节一致。许可和来源随独立测试素材保存，官方画稿不放进通用安装包。

`spine_create_rig_profile` 保存明确的全身/局部角色映射、链、弯曲方向、角度极限、部件、次级运动及接缝配置，返回控制器清单和姿态说明。`spine_audit_rig_profile` 定位越界的时间、骨骼和关节点；换工程必须完整重映射，换源后的接缝必须重做计划。不能把骨名映射当成自动解剖识别。

`spine_plan_motion_pack` 生成待机、走、跑、跳、招手、平面转身、蓄力七种配方，共享节奏/强度参数；`spine_create_motion_pack_task` 接入已有后台任务、断线恢复和精确候选审核。接触类动作至少 60 FPS，抬手/脚步使用实际骨链长度；双倍采样检查接触，容差没有放宽。当前为平面、原地、正向等比无剪切 FK 骨链；直接受 IK 等约束驱动的角色须采用已有控制器制作流程。转身只表示平面躯干转动，不会生成背面素材。次级运动沿用明确的延迟/增益/角度预算；跨动作转场可用已有 compose 工具，实际运行时混合用 `transitions` 验证。数值通过和调用方工程验收不会自动成为用户自然度认可。

`spine_create_facial_animation` 用已有嘴/眼附件及明确时间标注生成新动作。可提供本地 WAV/MP3/OGG，校验真实音频时长；不会识别语音或播放声音。原动作和未选通道保留。`spine_create_quality_board`、get/update 将问题、基线对照及处理历史固定到源和资源；“已处理”必须独立重跑原检查，截断清单不能声称全部解决。`spine_compare_repair_candidates` 使用相同源、镜头和采样比较多个候选，不自动批准胜者。

交付目标为官方 `@esotericsoftware/spine-core 4.3.13`。`spine_verify_runtime_delivery` 实际使用 AnimationState 连续播放、循环和可选跨动作混合，校验有限状态、事件/采样预算、图集路径和页面尺寸，并比较 JSON/二进制的完整状态。它不代表 GPU 像素、音频或其它引擎验收。`spine_deliver_character_package` 强制质量检查，收录原生工程、精确 JSON、二进制、图集、图片、许可、审核证据、运行时报告和相对路径哈希清单；搬移后再次加载验证。

`spine_connection_diagnostics` 区分服务进程、磁盘版本和调用方报告的客户端目录。仅当调用方提供公开的本机 WebSocket app-server 控制地址时才请求 MCP 重载；之后仍须目标对话调用确认版本。[公开控制协议](https://learn.chatgpt.com/docs/app-server) 不等于当前桌面已暴露入口。`spine_editor_context` 只被动观察关联进程标题和已知打开记录；不猜未保存状态和完整路径。

3.0.0 当时未实现当前工程/未保存状态与可编辑数据重载。3.1.0 已通过独立启动桥接补齐这两项，范围限定为上述固定构建和桥接窗口；官方 CLI 仍未提供通用的编辑器内存接口。预览图片发布和真实可编辑数据重载保留各自回执。

3.0.0 封版时完成 784 项单元测试、52 组集成验证及全部 226 工具成功调用覆盖；独立中文/空格目录的生产依赖安装、锁定 PSD 渲染器、安装后五组原生工作流和 Python 搬移均通过。详见发行包 `VERIFICATION.json` 与逐文件 `release-manifest.json`。28 项计划中 26 项按文档中的适用范围实现并验证，M2-2/M2-3 保留为明确上游限制；不将其计作已实现。

动作验证包含腿长比例 0.8/1/1.25 与独立裙装角色。裙装采用自身膝盖方向校准和 0.1 强度；跑步的局部网格修正最大约 0.29 坐标单位，原始草稿保留并排除出交付选择。官方七动作原视频获得用户认可；较早候选的端点浮点时间碰撞被原生导入拦截。独立示例包采用当前配方重新生成的通过版本，并附原审核及差异记录，未沿用原视频对新导出的自然度认可。交付包包含每个选中动作的独立 PNG 缩略图。

原生 CLI 曾在一次多骨架往返中改变一个颜色键；校验拒绝了该结果，同代码重试及独立安装检查通过，原因仍未确定。不会放宽校验或把上游偶发行为说成已修复。

## 2.21.0 完整角色验收、接缝建议与兼容修复

完整范围见 [COMPLETION-PLAN.json](COMPLETION-PLAN.json)：7 个里程碑、28 个有验收标准的工作项。2.21 完成 M1；3.0 将 M2–M7 的工作流纳入同一轮实现与验证，原生接口可行性关卡单独记录。

`spine_plan_mesh_seams` 对 2–8 个激活网格的边界或全顶点生成互近邻建议，给出距离、法线、歧义、几何评分和标注 PNG。评分不是人体语义概率，不自动接受候选。查看后，在联动修复的 `seamPlan` 提供精确计划 SHA、候选 ID 和 `use_reviewed_seams`；源、皮肤、几何或标注图改变都会拒绝。任务创建时同时固定计划与证据。

`spine_audit_mesh_seams` 独立检查指定动作和接缝，定位最大误差的时间、插槽、附件、顶点与世界坐标，并输出标注峰值图。保留源偏移模式必须给参考动作，必要时给参考皮肤及按 ID 对应的原始目标。修复失败也提供三角形面积、边长、固定点和位移预算的局部诊断。

联动修复默认仍拒绝链接依赖和物理。显式 `compatibility.linkedMeshes=isolated_skin` 加新 `outputSkin` 会独立化所选皮肤的有效网格、变形和原生占位符；原皮肤、动作及约束定义不改。新皮肤供新修复动作使用。显式 `compatibility.physics=sampled_capture` 以 60/120 FPS 捕获确定性运行时姿态并核对误差，只在派生动作关闭约束混合；这是有限采样捕获，不是编辑器实时物理或内存重载。仍执行双倍 FPS、原生近零量化、接缝/面积/边长/位移检查，不能发布失败候选。

完整角色验收使用官方 4.3 Mix-and-Match 项目，覆盖 143 骨骼、80 插槽、34 皮肤、373 附件和 6 个原始动作，三套完整皮肤逐姿态、原生回读图及搬移交付核对。样本有明确来源和原许可，未声称导入官方 PSD。官方素材不进入通用 MCP 安装包；独立验证可设置 `SPINE_PRODUCTION_FIXTURE` 指向已解压的官方目录（含 native/images/license.txt）。示例见 `examples/mesh-seam-workflow.json` 和 `examples/production-character-profile.json`。

## 2.20.0 统一制作任务与多网格联动修复

`spine_create_character_task` 新增 `authoring`：原始 PSD → 栅格证明 → 导入 → 地标草稿与修订 → 骨架、绑定、控制器和动作 → 可选 `meshRepair` → 审阅媒体 → 最终候选 → 原生发布。任务先在栅格和地标步骤暂停；`spine_review_character_task_stage` 必须选中准确的阶段结果 SHA，地标还必须指定当前计划 SHA。`revise` 只生成独立修订，之后仍须 `accepted`。最终候选确认是另一步，阶段确认不能代替它。返回的标注 PNG 随 MCP 响应显示，离线页面可以导出修订数据。

取消、断线和工作进程重启后复用哈希仍匹配的步骤。已消费的阶段不能改确认，须创建分支；分支不继承任何审阅决定。2.16–2.19 任务显式迁移为独立新任务，旧任务不改。地标可能重新修订，因此作者任务分支只复用安全的栅格前缀，重新计算下游绑定与动作。中间审阅和最终确认都属于调用方声明，不自动视为用户美术验收。

`spine_create_joint_mesh_repair` 同时处理 2–8 个独立网格。调用方给出接缝顶点对、固定顶点和各网格最大修正量；接缝可重合，也可保留源动画逐帧相对偏移。只在新动作写所选网格的 deform。先处理 Spine 原生导出的近零省略规则，再以双倍采样率核对接缝、固定点、位移、面积和边长。无解时返回失败，不能发布；不自动选择接缝或放宽容限。限额和物理、链接网格限制见 SUPPORT.json。

示例见 `examples/unified-authoring-task.json` 与 `examples/joint-mesh-repair.json`。`npm run smoke:unified-joint` 通过实际 MCP 验证任务暂停、修订、重连、联合网格候选和 Spine 原生回读。独立新角色验收保留生成原图、提示词、分层 PNG、合成 PSD、标注、媒体和便携交付包；原正式工程与已通过动作不修改。

## 2.19.0 关节标注、网格修复与高级 PSD 栅格化

`spine_plan_rig_landmarks` 先生成带标定关系的参考 PNG；可以不提供关节，先让 Codex 查看参考图，再提供像素、归一化或世界坐标。坐标与置信度由调用方提供，MCP 不包含人体识别模型。明确骨骼起止关节、父骨和绑定后，会生成标注 PNG、主导权重预览、精确权重 JSON 和可拖动关节点的离线页面。页面只导出修订 JSON；`spine_correct_rig_landmarks` 校验旧计划与显示证据后生成独立新版本。MCP 响应直接附带标注图。具备动作配方时，返回的蓝图可以交给现有 `spine_create_character_build_task`，仍须确认地标及最终候选。源工程和旧标注不修改。

`spine_create_mesh_deform_repair` 针对一个持续激活的独立网格，按三角形面积和边长上限投影修复翻面、拉伸，限制逐顶点最大移动并支持固定顶点。只写新动作中所选网格的 deform；拓扑、蒙皮权重、原动作和未选通道保持不变。按原生可保存精度输出，再按双倍 FPS 验证量化后的误差，并生成共享镜头的对照视频。无法在预算内修复时保留 `checksPassed=false`，不能发布。当前不处理物理或具有链接依赖的网格，整段动作最长 30 秒。原有损坏动作会保留用于比较，因此默认整工程质量检查仍可能拦截；返回的 `suggestedPublishQuality` 只明确选择新修复动作，使用它并不表示旧动作通过。

高级 PSD 工具另需本机 Python 和固定依赖；已验证 Windows Python 3.12。构建后运行 `npm run setup:psd-raster`，创建项目私有 `.psd-runtime`，不改全局 Python。之后 MCP 调用不访问网络、不打开图形软件。发行包安装器默认安装这一组件，显式 `-SkipPsdRaster` 可只安装普通像素 PSD 功能。

`spine_plan_psd_rasterization` 使用固定 psd-tools 1.26.0，处理可验证的矢量蒙版、描边样式及部分调整层。`flatten_document` 把整幅图合为一个附件；`flatten_top_level` 把每个可独立合成的顶层单元合成一个附件，嵌套结构丢失会列在 `semanticLoss`。顶层调整层、剪贴关系或依赖背景的组合应明确整体合并。栅格证明覆盖应用骨骼、皮肤和忽略标签语义前的像素单元；须同时检查普通导入计划。

独立渲染忽略文档合成缓存，可使用图层自身保存的像素；文档缓存仅作参考。Python 与 Node 分别比较预乘 RGB 和 alpha，最大分量误差须小于 3/255、平均须小于 0.35/255。超界、未知活动样式及无法独立重组的结果均阻止导入，不提供放宽阈值的开关。`spine_apply_psd_rasterization` 要求精确计划 SHA 和 `confirmation=use_rasterized_layers`；导入候选始终绑定原始 PSD 及证明文件。支持范围取决于逐份文件的证明，不能据此宣称所有 Photoshop 效果兼容。外部 Photoshop 样本及反例的提交、哈希和许可证见 `test/fixtures/psd-raster`。

示例：`examples/rig-landmarks.json`、`examples/mesh-deform-repair.json`、`examples/psd-rasterization.json`。`npm run smoke:visual-rig` 验证 5 个新接口、断开重连、原生工程回读和真实来源 PSD 对照。

## 2.18.0 完整制作任务、运行时接触修正和 PSD 像素合成

`spine_plan_character_build` 从已保存工程或通过预检的 PSD 计划生成完整制作蓝图：明确的骨骼/关节位置、网格蒙皮、二骨骼 IK、目标控制器及动作。控制目标可按设置姿态末端自动创建；弯曲方向可明确指定。动作既可用稀疏姿态，也可复用现有角色模板。返回世界关节点、控制器、动作清单及数据摘要，供调用方检查，不会推断人体解剖。

确认地标后用 `spine_create_character_build_task`，提供精确计划 SHA 和 `landmarkConfirmation=use_reviewed_landmarks`。随后使用原有 run/get/review_character_task。阶段顺序是 PSD 导入、准备、控制器、动作、补绘/换图、修正、评审媒体、冻结候选、确认、发布与已绑定预览回执。未指定媒体时为最多四个新动作生成 APNG。新绑定和约束可能影响候选中的原动作，蓝图会明确提示；源文件保留。最终候选仍需独立确认。

客户端断开后后台继续；取消或进程退出后复核并复用完成阶段。分支只改动作时可复用导入、网格和控制器；修改绑定会使下游失效。支持显式从 2.16/2.17 任务迁移，不混用旧数字处理阶段。

`spine_create_ik_contact_repair` 的 `solver=runtime` 处理脚骨偏移、部分 IK mix 和软 IK，使用官方运行时进行有界逆向求解。`allowFk=true` 明确允许在新动作中编辑选定上下骨的 FK 旋转，以覆盖 FK→IK 过渡；约束和 mix/softness 轨道保持可编辑。默认 `solver=strict` 延续旧模式。正向等比缩放、正常继承、无剪切/伸缩/物理等边界仍适用。过渡淡入淡出路径超出物理可达范围时可投影到可达边界，实际接触区间不投影；报告给出最大调整和双倍 FPS 误差。不能到达的接触仍拒绝。每次至多 300 万次逆解骨骼计算和 30 万个校验姿态，输出编辑器 FPS 至少为 240。

PSD 新增普通像素蒙版（包括密度和禁用状态）、剪贴图层、组透明度、隔离组及 `[merge]`，生成新图像并列出合成操作。剪贴合成保持基底 alpha。隐式扁平化将丢弃子骨骼/皮肤语义时会阻止，需明确合并或调整分组。矢量/羽化/复合真实蒙版、样式、调整层、非默认 Blend If、依赖背景的穿透混合等仍需先栅格化。

回归样本包含上游实际由 Photoshop 保存的 PSD 与合成参考图，见 `test/fixtures/psd-authored`。合成校验使用预乘 RGB 和 alpha，避免把透明像素的隐藏 RGB 当成可见误差；样本要求最大分量误差小于 3/255、平均小于 0.2/255。另含独立来源的嵌套剪贴 PSD，以文件保存的合成缓存作为参考，要求逐像素一致；来源提交和许可证随样本保留。原生导入后的显示另行回读核对。中间合成限制 6400 万像素及 2048 次栅格操作。

示例：`examples/character-build.json`、`examples/runtime-contact.json`。运行 `npm run smoke:construction-runtime` 检查实际 MCP、外部 PSD、完整后台制作任务与原生接触姿态。

## 2.17.0 任务分支、脚掌接触和 PSD 后台导入

用 `spine_plan_character_task_branch` 对已完成或暂停的任务提交 `patch`。计划逐阶段报告复用、重算及原因；换图只重算依赖该图的阶段，只改评审媒体可复用合成、换图和动作阶段。`spine_apply_character_task_branch` 按计划 SHA 创建独立子任务，保留父任务与旧候选，子任务生成新候选并重新确认。父任务原有会话绑定默认移除，避免分支沿用已失效的正式版本号。运行新任务使用原有 run/get/review 工具。

任务来自 2.16.0 时先预检，明确设置 `allowVersionMigration=true` 才能创建迁移分支；仅完整复核的纯合成可跨版本复用，其余阶段重算。当前版本可复用同版本匹配依赖的阶段。原始工程或资源漂移默认阻止；`acceptSourceDrift=true` 会捕获当前来源并重算相关阶段。计划后父任务状态、来源、素材或阶段文件变化会阻止应用。新分支不会继承旧结果的确认。

`spine_create_ik_contact_repair` 接收脚部局部坐标的 heel/toe、接触区间和过渡时间：`sole` 固定两个接触点与脚掌朝向；`heel`/`toe` 可使用明确角度路径绕支点滚动。只在新动作中编辑 IK 目标平移与脚部旋转，原约束和动作保留。任务的 `contactRepair` 阶段位于 IK 目标修正后、评审媒体前。

适用边界是独立二骨骼 IK、mix=1、softness=0、无伸缩/物理、正常继承、正向等比缩放及无剪切，脚骨原点须在小腿末端。每段至多 600 个目标样本；双倍 FPS 检查接触点、朝向、范围外和无关骨骼。不可达、重叠过渡或脚掌接触期间长度改变会拒绝。明确地标和有限采样不表示自动识别人体或自然动作验收。

`spine_plan_psd_import` 先检查 PSD，`spine_import_psd` 再按计划 SHA 导入为新的 PNG、骨骼、插槽、皮肤和便携 JSON。支持普通分组、隐藏图层、图层透明度、绘制顺序、参考线或 origin，以及 bone/slot/skin/folder/path/pad/trim/bones/slots/ignore 标签。只有命名皮肤时返回 suggestedSkin，需在 Spine 或渲染参数中选择皮肤；不注入可能和占位符冲突的默认附件。reviewSkin 可明确选择评审皮肤。共用插槽的附件是互斥候选，只激活最上方可见者。占位符与真实附件名称分开，普通皮肤的真实名称按皮肤限定；默认皮肤附件保持原名。默认附件与同插槽的皮肤占位符同名会明确阻止，需在 PSD 中移动或重命名。

PSD 支持标准 v1、RGB、8 位缓存像素，限制源文件 32 MiB、单边 8192、画布 1677 万像素、累计图层 6400 万像素、256 图层和 24 层嵌套。蒙版、图层样式、裁剪、矢量/调整层、部分填充、组透明度/混合隔离及其他标签会明确阻止，需先在绘图软件栅格化。文本/智能对象只导入保存的像素。RGB 数值保留；ICC 文件留档，Spine 纹理不作 ICC 转换。输出 PNG 用安全生成名，PSD 逻辑路径记录在清单中。

较大 PSD 可用 `spine_start_job` 的 `operation=import_psd`、`args` 为相同导入参数，断开客户端后继续；可取消/恢复，未完成请求按同一 ID 复核并复用已写 PNG。导入不写原 PSD 或当前正式工程。查看候选后用 `spine_promote_character_candidate(native=true)` 创建并校验新的原生工程。该后台导入器采用 [ag-psd](https://github.com/Agamnentzar/ag-psd)，标签与格式边界参考 [Spine PSD 文档](https://en.esotericsoftware.com/spine-import-psd)。

示例：`examples/task-branch.json`、`examples/live-ik-contact-repair.json`、`examples/psd-import.json`。`npm run smoke:branch-contact-psd` 验证实际 MCP、重连、PSD 后台队列和原生往返。

## 2.16.0 后台角色任务、真实素材和可编辑 IK

`spine_create_character_task` 保存不可变计划、源文件/资源快照和各阶段请求 ID。`spine_run_character_task` 将它提交到现有独立后台队列；`spine_get_character_task` 读取阶段产物、缺图、候选、媒体、来源漂移和当前任务。客户端断开不终止工作；工作进程退出或取消后，可再次 run，或对返回的 job ID 使用 `spine_recover_job`。完成阶段必须通过文件哈希复核才复用。

阶段顺序为：可选补绘合成 → 批量换图计划/应用 → 可选原有局部动作修正 → 可选实时 IK 目标修正 → 评审媒体 → 最终便携候选 → 明确确认 → 原生发布/一次会话提交 → 精确预览回执。换图和动作修正组合后的最终候选仍绑定最初工程；阶段产物不会逐项推进正式版本。

- 图片引用可写 `{ "asset": "outfit" }`，补绘结果可写 `{ "repaint": "skirt" }`。缺图时返回 `awaiting_assets` 并释放后台进程。Codex 在 MCP 外调用图像生成，再用 `spine_supply_character_task_assets` 提交本机 PNG，随后 run。MCP 不调用模型、执行提示词或做语义拆图。
- `awaiting_review` 需要查看候选/媒体后，用 `spine_review_character_task` 提交精确候选 SHA、accepted/rejected 和说明，再 run。确认是调用方报告的选择，不是认证的人类身份。拒绝不会发布。等待图片/确认时重复 run 不创建多余任务。
- 已完成阶段用过的素材以及冻结候选不能悄悄替换；需另建任务。尚未被完成阶段使用的错误素材可明确补交，失败及后续阶段获得新请求 ID，已完成阶段保留。来源/资源漂移或损坏的阶段产物拒绝复用。
- 原生发布和会话提交使用稳定请求 ID；丢失提交回执后重试不会多加版本。原生预览验证使用提交回执中的精确代数和源哈希；渲染等待失败后只重试该阶段，外部改变/失败的预览绑定需要先检查。文件发布回执不证明编辑器已显示。
- `reviewMedia` 最多 8 组，可导出已存在动作或新增修正动作的 MP4、APNG、GIF 和分页序列图。任务计划/阶段与构建版本绑定；跨构建升级需显式迁移分支（2.17 支持从 2.16 迁移）或保留旧构建继续，不能直接混用旧阶段语义。

`spine_create_ik_target_repair` 在新动作中仅改指定 IK 目标的平移轨道，支持带平滑淡入淡出的世界偏移和明确世界路径点。IK 约束、mix 等参数轨道、其他控制器和原动作保留可编辑状态，不执行整骨架烘焙。默认双倍采样率检查目标位置、范围外和无关骨骼世界矩阵；`endEffectorTolerance` 可额外要求末端到达目标。一骨骼 IK 默认只保证指向目标，不默认为末端接触。

当前适用于活动的一/二骨骼 IK、独立控制目标和未被约束影响的目标父层级。物理相互作用、受约束的控制器/父级、同目标重叠窗口和混用 translate/translatex/translatey 会拒绝；分开的 translatex/translatey 可编辑。每个任务最多 20,000 个控制器关键帧、300,000 个验证骨骼姿态，有限采样不证明连续误差或自然解剖。

补绘新增 `alignment.mode=bounds`，用明确的 from/to 矩形分别匹配横纵比例。生成器改变画布占位时，先给出几何对应，再只合成可编辑掩码；原始轮廓、接缝和保护区由原图保留。它不自动推断人体或服装语义。

示例见 `examples/character-task.json`、`examples/live-ik-target-repair.json`。完整复现：`npm test`、`npm run smoke:character-tasks`、`npm run audit:features -- --parallel 4`。真实生成素材验收记录位于 `work/real-generated-assets-2.16.0.json`；其中的人工遮挡测试明确标记，Codex 检查和用户确认分开记录，原正式五动作工程不被覆盖。

## 2.15.0 补绘回填、批量换装和带约束角度修复

三项流程都保留原图片、原生工程和原动作。生成结果先成为独立候选，明确选用、通过质量检查和原生往返后，才可作为一个新会话版本提交并更新绑定预览。

| 新增/扩展工具 | 用途 |
| --- | --- |
| `spine_compose_layer_repaint` | 将 Codex 已生成的 PNG 按画布或锚点对齐，只合成显式补绘遮罩，精确保留保护区域和遮罩外 RGBA |
| `spine_plan_batch_image_replacement` | 一次预检1–64个换图项，共用同一源/资源/构建快照，报告所有失败项、重复选择和共享 UV 冲突 |
| `spine_apply_batch_image_replacement` | 将通过计划的全部图片写入一个可移植候选，相同内容只复制一次，统一合入一个版本 |
| `spine_create_animation_repair` | 扩展 `constraintMode=bake`、`physics`、`bakeTolerance`，在新动画中捕获约束后修复局部角度并核对未选骨骼世界姿态 |

**补绘合成。** 先准备2.14图层交接包与显式 `repaintMask`/`protectedMask`，再传入 `repaints`。默认按 `alignment.mode=canvas, fit=contain` 居中等比适配；可选择 `cover` 裁切填满、`stretch` 明确拉伸或 `exact` 要求同尺寸，并指定像素偏移。`mode=anchors` 用一个源/目标锚点及缩放/旋转，或两对锚点自动解算等比缩放与旋转；目标锚点省略时使用交接包 pivot。坐标 x 向右/y 向下，正旋转为顺时针；不推断人体、语义关节或内容对应点。

采样可选 nearest 或使用预乘 alpha 的 bilinear，避免透明彩色像素带来插值色边。`blend=replace` 按软遮罩替换，`over` 按透明度叠加。保护遮罩中**任何非零 alpha** 都锁定整像素；无补绘 alpha 的像素也保持原值。使用 pngjs 直接读取8位 RGBA，写回后独立读回核对，保留零透明度下 RGB 和半透明颜色；不经过 resvg 预乘/反预乘来保存保护区。底图色彩配置块随输出复制；生成图颜色按底图编码空间解释，不自动转换色彩配置。只接收8位静态 PNG，其他位深/APNG须先明确转换/选帧；原 PNG 字节不覆盖。单项沿用16 MiB/1600万像素限制，整次解码/输出访问限6400万像素。

输出含新 PNG、对齐矩阵、修改/裁切统计、标准拼合/差异图和交接审计。补绘仍不透明不足、或保护/补绘选区矛盾时，审计保持失败，不能导入。将返回 `replacements` 交给 `spine_import_layer_handoff`。图像生成仍由 Codex 的图像工具在 MCP 外完成；检查通过不代表隐藏结构或画面自然。示例见 `examples/layer-repaint-composition.json`。

**批量换图。** 各项使用已有单图的尺寸、比例、锚点和 UV 策略，显式指定皮肤/插槽/附件。所有修改独立地对同一原快照预演，然后按附件字段合并；相同共享 UV 变化只合并一次，不连续重复映射，冲突则拒绝整批。错误中的 index 从0开始。任意图片缺失、变化、选择重复、计划损坏或新旧构建不一致，均不提交正式版本。相同 PNG 内容可共用一次复制。先生成一个 `batch_image_replacement` 候选，再通过现有 `spine_promote_character_candidate` 用精确候选哈希、会话 ID 和代数统一提交，重试复用同一版本。保留骨骼、权重、变形和全部动作；若需要运行时多套皮肤，可先用已有皮肤工具准备目标皮肤，再批量填图。会话版本提交与原生屏幕/多纹理显示回执不同。示例见 `examples/batch-image-replacement.json`。

**带约束角度修复。** 默认模式仍拒绝直接修改受约束骨架。显式 `constraintMode=bake` 按原有约束顺序捕获整骨架、插槽及变形到新动画，并仅在该新动画中关闭约束混合，随后修复指定骨骼/时间范围；原动画、骨骼、约束定义及控制保持。支持现有烘焙器覆盖的现代4.3 IK、变换、路径、物理等约束布局。物理需明确 `physics=true`，按配置 FPS 从零重置捕获；对照视频会区分原版物理模拟与修订版已烘焙姿态，不重复模拟修订版物理。

候选报告保留约束顺序、声明骨骼引用、受影响的后代骨骼，以及双倍 FPS/精确边界的局部角度与世界矩阵误差。修复/接地范围内允许选择骨骼及后代变化；其余骨骼与范围外姿态按 `bakeTolerance`（默认0.05，世界矩阵各分量最大差）核对。物理参考采用独立重置的同一捕获历史，上限100万累计骨骼积分步；过量/超差拒绝。内部时间范围端点仍必须已符合限制，不允许凭空改变范围外动作。选择的骨骼必须在指定皮肤中激活。新修复关键帧按浮点32位合并微秒内重合时间，避免烘焙时刻与 FPS 采样相遇、导入后形成重复键。有限采样不表示动作自然，也不承诺在新动作中继续实时求解原约束。示例见 `examples/constrained-animation-repair.json`。

`npm run smoke:character-refinement` 在带空格/中文路径的隔离工作区验证保护像素、补绘导入、整套换图一个版本提交、共享链接 UV 原生往返，以及四类约束修复/对照/预览更新。测试只对合成用例记录明确选用，不推断用户视觉验收。完整审计新增该流程，共42组；证据见 `work/feature-audit-report-2.15.0.json`、`work/character-refinement-report-2.15.0.json`。PNG 解码器固定为 MIT 许可的 pngjs 7.0.0，发行包附许可证。

## 2.14.0 图层补绘、保护动画换图和动作修复候选

本阶段完整流程是：**准备素材 → 检查补绘/替换 → 生成独立候选 → 查看对照 → 明确选用 → 质量检查与原生验证 → 可选提交会话并更新绑定预览**。候选阶段保留原图片、原骨架和所有原动作，不自动修改正式工程。

| 工具 | 用途 |
| --- | --- |
| `spine_prepare_layer_handoff` | 原图、图层、画布位置、局部锚点、显式补绘/保护遮罩及哈希打包 |
| `spine_audit_layer_handoff` | 检查补绘 PNG 尺寸、遮罩覆盖和保护像素，输出拼合图、差异图及报告 |
| `spine_import_layer_handoff` | 校验通过后，生成带锚点骨骼的独立可移植 JSON 候选；可向已保存骨架追加图层 |
| `spine_plan_image_replacement` | 预演换图，报告尺寸、比例、锚点、UV 和共享链接影响，固定源/资源/构建版本 |
| `spine_apply_image_replacement` | 应用精确计划到独立候选，复制图片，保留骨骼与全部动作关键帧 |
| `spine_create_animation_repair` | 根据显式接地链或局部旋转范围生成新动作、前后诊断和固定共享视口对照 |
| `spine_get_character_candidate` | 读回候选并核对清单/资源，报告原始源漂移 |
| `spine_promote_character_candidate` | 明确选用精确候选后发布新 `.spine`，可按会话代数提交并更新绑定预览 |

图层坐标采用原图像素，x 向右、y 向下；图层数组从后向前。`pivot` 是图层自身画布像素坐标，`origin` 为原图的 Spine 原点。导入时转成指定父骨骼的局部坐标。已保存工程缺少默认皮肤时自动创建，支持先建空白工程再导入，也保留已有命名皮肤。补绘/保护遮罩以 **alpha** 表示区域，颜色不参与选区；生成的 PNG 必须保持图层画布尺寸。`minCoverage` 默认0.98，`maxProtectedError` 默认0；可配置整图预乘 RGBA 平均差异阈值。拼合差异是检查依据，不等于补绘的视觉正确性。**图片生成由 Codex 的图像工具负责，MCP 不内置生图模型，也不自动猜测语义拆图或人体关节。** 本版提供 PNG 图层清单，不宣称支持 PSD 解析；参考 `examples/layer-handoff-workflow.json`。

换图默认 `resizePolicy=reject`。明确选择 `preserve-geometry` 可在新画布尺寸下保留区域附件的显示范围，或保留网格顶点、权重、变形和关键帧；宽高比改变还需 `allowAspectChange=true`。区域附件可提供旧/新像素锚点，使该点位置不变。网格默认保留归一化 UV，显式 `uvMapping` 可映射补边/裁切后的新画布；越界 UV 拒绝，共享 UV 影响链接网格时必须明确 `propagateLinkedUVs=true`。单张 PNG 不替换图片序列。原图不覆盖，新图片和其余资源收集进独立候选目录。示例见 `examples/image-replacement-workflow.json`。

修复动作始终使用新的 `newName`，保留所有原动作。接地使用已有双倍 FPS 验证求解器；接地时刻和三骨骼链由调用者提供，约束模式沿用显式 `constraintMode=bake`。旋转限制修复当前用于无约束骨架，支持显式时间范围；范围内部端点须已满足限制，以免把突变带到未选范围。曲线边界采用运行时拆分，在双倍 FPS 和精确边界检查范围外旋转及限制误差。诊断通过不表示姿态自然。示例见 `examples/animation-repair-workflow.json`。

对照使用两个动作的共同视口和同一批时刻，输出标注 ORIGINAL/CANDIDATE 的 PNG 序列、可拖动/播放 HTML 和经 FFprobe 核对的 MP4。默认12 FPS、单侧320×480；最多180帧、6400万输出像素，视频64 MiB；显式 `comparison.video=false` 可只生成图帧/播放器。对照需要所选皮肤有可见图片。视频使用本机 FFmpeg/FFprobe，物理接地的对照使用明确的重置模拟参数和积分预算。

选用需 `confirmation=use_reviewed_candidate`、精确候选 SHA256 和说明；这是调用者报告的选用，不是身份认证或原生显示回执。默认原生发布、不打开编辑器；`openInEditor=true` 才明确打开。绑定 `session.id/expectedRevision` 时，源分支/代数必须匹配，原生往返和质量检查通过后才新增会话版本、通知已绑定预览。未通过、资源改变或损坏的候选拒绝选用。精确 requestId 重试复用回执；中断在会话提交后也复用同一检查点，不重复增加版本。支持保存的单骨架原生项目，多骨架仍使用现有专用工具。

专项回归：`npm run build` 后执行 `npm run smoke:character-pipeline`，在带空格/中文资源名的隔离工作区，验证补绘拒绝/通过、三种候选原生往返、保护原图和动作、MP4帧数、会话提交与自动预览发布、精确重试。完整审计包含该流程，共41组；验收结果保存在 `work/feature-audit-report-2.14.0.json`。

## 2.13.0 精确豁免、格式升级、动画接缝和存档维护

新增9个工具。`spine_prepare_quality_waiver` 按动作、槽位、三角形编号和时间段生成待审报告；查看报告后，`spine_approve_quality_waiver` 需要原草稿哈希、固定requestId、`confirmation:reviewed_exact_report` 和原因。批准结果的path/sha256加入quality.waivers，多骨架会话可指定skeleton。只放行记录中的mesh_fold，绑定完整规范化数据、图片/音频、构建版本和采样设置；重定位资源目录允许，数据/内容变化要求重新审查。新问题、面积变大、未列出的时间点、其它诊断和被截断的结果继续拦截。原始findings保留；批准是调用者声明，不代表系统识别或认证了人类审阅者。

会话使用`spine-project-session/2`。`spine_migrate_session` 可显式迁移；普通新操作也会迁移。首次迁移先保存旧state.json的原始字节，再原子提交新版。2.12及更早进程会拒绝新版schema；未来的minimumWriterVersion也会阻止较旧写入者。读取旧会话不写文件。升级后重载MCP再操作会话。

已完成回执超过256条时自动分段，或调用`spine_compact_session_receipts`。旧requestId的签名、结果和代数保存在不可变哈希段中；索引查询仍返回旧回执，不重复执行。待完成回执保留在线。总量上限100000，元数据仍限16MiB，单段8MiB；不是无限保留。归档回执损坏时拒绝重试，不自动重新执行。

`spine_audit_animated_seams` 要求animation、明确的seams数组，每项指定a/b槽位、bone、骨骼局部point、世界单位radius，可选start/end和覆盖阈值。按fps采样并加入精确区间边界，报告露缝/重叠不足/缺附件帧，附关节裁图和红色未覆盖点。默认12fps、每轴9点，最多300帧/20条接缝/20万圆形采样/200万三角形测试。检查原始图层透明度，未计算裁剪和最终遮挡；不识别解剖结构，也不证明连续或原生GPU显示。

`spine_plan_archive_cleanup` 对最多100个original-UUID存档进行只读预演，默认最小年龄24小时，返回引用所有者、可隔离字节和planSha256。会话保留历史、预览/同步/任务元数据、JSON与原生工程和共享资源引用会保护存档。诊断报告不作为活动引用；reports目录中的真实工程JSON仍受保护。原始工作文件不会清理。扫描遇到链接、坏JSON、过大文件或预算不足会拒绝；大型工作区应明确提高预算或使用项目独立工作区。

确认预演后，`spine_apply_archive_cleanup` 使用planId/expectedPlanSha256/requestId将无引用存档移入隔离区；重新扫描、核对哈希与清单外文件，逐步记录日志，中断可继续，新引用冲突会回滚。`spine_restore_archive_cleanup` 可恢复原路径，拒绝覆盖现存冲突。隔离保留数据，**不会释放物理磁盘空间**。确实需要永久删除时，`spine_purge_archive_cleanup` 另需purgeFingerprint和`confirmation:permanently_delete_quarantined_archives`，重新检查引用后才删除；永久删除不能恢复。两次扫描无法锁定任意外部程序或读取未保存编辑器状态；操作期间应保持其它外部写入暂停。

验证入口：`npm run smoke:maintenance-upgrade`，包含真实旧版2.12写入拒绝、回执重试、动作接缝、合成问题的精确豁免、隔离/恢复/永久删除自有测试副本，以及原生工程引用保护。`npm run audit:features -- --parallel 4` 运行40组回归，预览请求的双会话恢复测试独立运行。

## 2.12.0 发布质检、会话管理和活动续期

新增五个工具：`spine_check_publish_quality`、`spine_configure_session`、`spine_set_session_archived`、`spine_get_session_storage`、`spine_touch_session`。

会话的编辑、检查点和恢复，在提交历史前自动质检；`spine_publish_and_open` 在原生构建前质检，`spine_deliver` 在收集资源和原生构建前质检。默认采样全部动画，以完整三角形范围内的像素中心检查网格折叠，按透明度、裁剪及上层不透明遮挡过滤。关节限位、脚接触、肢体间距/交叉及逐帧位移需要提供角色专属规则。不会自动识别解剖结构，也不会把数值通过当作视觉通过。无动画时明确报告 `noAnimations`，只核对资源。

`quality` 可设 `mode: enforce|report`（默认 enforce）、`animations` 子集、`fps`（默认60，最高120）、`maxSamples`（默认6000，最高50000）、`visibilityPixelSize`（默认0.1世界单位）及 `rules`。每条规则含 `animation` 与可选 `skin/start/end/fps/physics/physicsFps/contacts/joints/separation/limbPairs/maxStep/stepBones`；省略规则 FPS 时继承策略 FPS。精确接触边界计入采样预算，预算耗尽或检查异常不会通过。像素分辨率与有限采样仍可能漏掉间隙内的问题。report 模式须显式指定，允许继续但保留失败结果。原始编辑/构建工具仍可用于草稿，正式发布应使用上述带质检的工作流。

会话通过 `configure_session` 修改 name、maxVersions、maxArchiveMiB、quality、previewLease；每次替换指定策略，需使用当前 revision 和固定 requestId。新上限不能小于已保留用量。归档隐藏会话、解除预览绑定并阻止继续编辑；解除归档保留历史，不自动绑定或打开。归档不删除文件，也不停止可能被其它会话共享的预览。容量工具报告快照账面字节、剩余版本和80%提示，不承诺清理物理磁盘。单会话最多保留1024条修改回执，之后开始新会话。

previewLease 默认 `{enabled:true,durationSeconds:3600,renewBeforeSeconds:120}`。仅在显式编辑或 `touch_session` 活动时续期，不在空闲时永久保活；手动 stop 优先。续期沿用同一预览 ID，持久化独立请求回执，丢失响应后可安全重试。普通查询、重命名和归档不会续期或刷新图片。编辑之外改变预览代数后须重新绑定。文件提交和预览发布分别报告，预览过期或手动停止不会撤销已完成的合格文件。失败候选文件及质检报告保留，原文件不覆盖。

编辑器桥接调研已更新：官方 FAQ 说明目前没有插件系统，公开 CLI 未提供未保存内存、可编辑骨架热重载或原生时间轴控制接口。`spine_check_environment(probeCli=true)` 返回本机探测与能力边界。已有专用图片/序列预览、保存文件编辑和打开工程可继续使用；这些不代表拥有编辑器内存 API。[官方 FAQ](https://en.esotericsoftware.com/support)、[CLI 文档](https://en.esotericsoftware.com/spine-command-line-interface)。

回归入口：`npm test`、`npm run smoke:session-lifecycle`；`npm run audit:features` 包含新流程并记录162个工具的成功调用覆盖。

## 2.11.0 工程会话、历史恢复与拆图辅助

新增 8 个工程会话工具和 2 个角色辅助工具。会话指显式绑定的**已保存文件**，不是编辑器当前窗口或未保存内存。

| 工具 | 用途 |
| --- | --- |
| `spine_create_session` | 以 `input/name` 创建会话，存档工程和全部引用图片/音频；可固定 `skeletonName`。可选 `requestId` 去重创建。 |
| `spine_get_session` | 返回当前路径、`revision`、历史、预览绑定和文件/资源的外部变化。 |
| `spine_list_sessions` | 重连后查找持久化会话；不会猜测当前编辑器工程。 |
| `spine_bind_session_preview` | 绑定已有 `previewId` 并更新其画面；传 `null` 解除绑定。不会打开/续期预览。 |
| `spine_checkpoint_session` | 保存检查点；可选 `input` 选择新的工作分支。外部变化需显式 `acceptExternalChanges=true`。 |
| `spine_edit_session` | 对当前分支编辑，生成新文件、存档新版本并通知绑定预览。原生工程重新核对全部骨架。 |
| `spine_compare_session_versions` | 核对历史存档后比较数据和资源内容，返回 JSON 指针差异；忽略存档引起的资源目录与导出 hash 变化。 |
| `spine_restore_session` | 将指定 `versionId` 的数据和历史图片/音频恢复为新文件，再更新会话及预览。多骨架恢复到新 `.spine`。 |
| `spine_audit_character_layers` | 检查设置姿势下活动区域/网格的透明度、空图层、透明范围，以及关节附近的覆盖和重叠比例。 |
| `spine_suggest_character_rig` | 按显式图层链和父骨骼生成可复核的骨点、网格与权重配方，供 `spine_prepare_character` 使用。 |

会话修改须同时提供 `id`、当前 `expectedRevision` 和固定的 UUID `requestId`。相同请求重试返回原回执，不重复编辑、不把较新的分支倒回去；参数不同不能复用 ID。每次新操作先查询当前 revision。状态和修改回执在同一个原子 JSON 中提交，跨进程操作使用独占租约。若进程在生成输出后、提交历史前退出，已有输出会保留且不会覆盖或自动接管；先检查，再显式 checkpoint 采用该分支，或使用新输出路径重试。

默认保留 30 个版本、最多 1024 MiB 存档，可配置到 100 个版本和 4096 MiB。单版本沿用原存档的 1 GiB/20,000 文件上限，会话最多跟踪 10,000 个引用资源，元数据上限 16 MiB。达到限制会拒绝新版本，已有历史保留；失败构建的诊断/未提交产物也保留。恢复文件引用独立历史存档中的资源，脱离原始图片后仍可使用；需制作独立交付目录时再使用 `spine_deliver`。历史原生文件字节保持在存档里，重建的新工程不承诺保留所有编辑器内部信息。

当前文件或图片/音频在编辑器之外变化时，编辑默认拒绝。保存外部修改后可用 `checkpoint(acceptExternalChanges=true)` 明确采纳；当前资源已丢失时，可用 `restore(acceptExternalChanges=true)` 从完整历史恢复到新文件。这两个选项都不覆盖原工程或资源。

预览绑定保留预览 ID 和已请求代数。预览被其它操作切换后，需显式重新绑定。文件历史提交与预览请求分开报告：`requestReceipt.preview.state` 为 requested/failed/not_bound/superseded；更新失败时文件和历史仍保留。requested 仅表示请求已提交，使用 `spine_wait_native_preview({id, options:{generation,waitMs:30000}})` 核对发布，不表示 Spine 已显示。2.12 起，后续编辑或 touch 可按租约续期；绑定本身不会续期、打开窗口、控制原生播放或重载可编辑骨架。

图层审计的 `seams` 需要两层、世界坐标 `point`（可选）和世界单位 `radius`。未给关节点时仅提供几何包围范围的候选，不识别人类关节。使用 PNG 双线性透明度与图层透明度，对圆形区域离散采样；结果属于裁剪/遮挡之前的原始图层，不代表完整动作或最终可见性。默认每轴 17 个采样点；上限 64 个选定活动图层、6400 万像素访问、20 万三角形、200 万三角形点测试及 20 万采样点。

绑骨建议使用 `chains:[{namePrefix,parent,layers:[{slot,attachment?}],points?}]`。显式世界骨点数量必须为图层数加一；未提供时使用透明像素主轴和包围范围推测，`requiresReview=true`、`anatomyInference=false`。只写建议报告，不直接修改工程或 PNG。配方显式携带 `minWeight=0.00001`，清除会被原生导入器丢弃的极小权重并归一化；可设为 0 保留全部正权重。原有 `spine_prepare_character` 调用的默认 minWeight 仍为 0，保持原行为。相关变形或链接不兼容时仍拒绝准备，不静默删除动画。

修正了原生导入的音频目录：Spine 4.3.23 会原样保存 JSON 的 audio 字符串，现在把它计算为相对于最终新工程的路径；图片和音频在不同目录、中文/空格文件名和多骨架导入均使用相同规则。`npm run smoke:complex-projects` 在只能访问搬迁目录的独立 Workspace 中核对真实 PCM WAV、原生工程及事件时间/参数，并结合官方 Cloud-pot 的多条物理约束、Stretchyman 的路径/变换约束验证多骨架修改和历史恢复。音频字节与引用核对不等于已在编辑器听取音效。

针对性入口：`npm run smoke:sessions`、`npm run smoke:character-assistance`、`npm run smoke:complex-projects`。完整覆盖入口 `npm run audit:features` 包含新增三组流程。

## 2.10.2 复杂网格预览修复

贴图现在每次渲染只解码一次，并在各姿态间复用。三角形统一使用共享边归属规则、预乘透明度双线性采样和每轴两次子像素采样，消除逐三角形 SVG 裁剪造成的内部接缝。槽位颜色、双色着色、整层透明度、混合和裁剪仍按原顺序处理。每次最多 2.56 亿子像素候选，超出时拒绝并提示降低尺寸或采样数量；CPU 与游戏 GPU 的边缘效果仍可能不同。

资源收集时省略没有音频引用的空音频目录，防止导入器把它固化为原位置的绝对路径；新增搬移后原生工程的目录核对。原工程与有引用的音频资源保持原处理方式。

播放缓存准备完成后保持 `building`，直到所选图片实际发布，才返回 `playing`/`paused` 及对应图片回执。版本变化使原生序列和实验播放的旧渲染缓存失效。真实角色在相同 512×768、相同时刻与取景下的单帧实测从 89897 ms 降至 843 ms；这是本机单次对照，不是所有工程的性能保证。实战交付记录见 `work/current-production-delivery.json`，本版完整覆盖报告为 `work/feature-audit-report-2.10.2.json`。

## 2.10.1 重连重试和并发保护

本版扩展现有工具参数，工具数量保持 147。

- `spine_start_native_preview`、`spine_start_native_sequence_preview` 接受可选 `requestId`，格式为小写 UUID v4。首次创建将它作为会话 ID；同一源工程、资源版本和创建参数的重试复用同一会话。省略时仍创建新会话。参数、源文件或引用资源已变化时，同一个 ID 会报冲突；可用 `spine_get_native_preview` 查询原会话。
- 创建请求在输出目录建立之前持久化，并在独立创建租约下执行。并发重试返回同一会话及 `creationPending: true`；创建者退出后，重复原始调用会在原目录继续准备。已有 `.spine` 必须重新导出并独立核对，通过后才复用，不再次导入或覆盖。准备 JSON 或原生内容冲突会保留文件并报错。
- 已完成、停止、到期或已取消的创建请求重试不会重新启动会话或续期。未完成的创建不能直接 `update`、`resume` 或启动实验播放，应重复原始创建调用。创建中的 `stop` 在阶段边界取消；正在执行的 CLI 步骤可能先结束。取消后的创建请求保留取消状态，开始新会话需新 ID。
- `spine_update_native_preview`、`spine_resume_native_preview`、`spine_stop_native_preview` 新增可选 `expectedGeneration` 和 `requestId`。`expectedGeneration` 填入查询结果的 `pendingGeneration`；过时请求在改动前被拒绝。同一 ID 与相同参数只提交一次，回执与请求改动写入同一份原子 JSON，重连后可查询重试。该 ID 在同一会话的三类操作中共用命名空间，不同操作或参数不能复用。
- 返回的 `requestReceipt.generation` 是原操作提交的代数，`requestReceipt.reused` 表示重放已有回执。即使后来已有新修改，重试旧更新、旧停止或旧续期也只返回原回执，不影响新操作。用该代数等待同步时，较新的请求可能使结果成为 `superseded`。历史回执不重新验证历史画面。
- 每个会话最多保存 1024 个带 ID 的修改回执，旧 ID 保留；达到上限后新 ID 报错。原回执重试及不传 ID 的原有调用方式仍可用。现有旧版会话可以使用修改回执；不会用新创建 ID 自动接管一个没有创建记录的旧目录。

创建参数示例：

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "input": "character/animation.json",
  "options": { "animation": "run", "width": 512, "height": 512 },
  "sequence": { "nativeFps": 30 }
}
```

同一次修改重试保留 ID、条件和参数；每次新的逻辑操作使用新 UUID：

```json
{
  "id": "实际预览 UUID",
  "requestId": "00000000-0000-4000-8000-000000000002",
  "expectedGeneration": 1,
  "changes": { "refit": true }
}
```

`npm run smoke:preview-requests` 使用实际 MCP/CLI 验证并发创建、断开重连、更新去重、过时代数拒绝、旧停止回执不停止新恢复、续期重放不重复延长寿命，以及辅助进程在真实原生导入后退出时的同工程恢复。测试不打开 GUI。2.10.1 的完整覆盖报告为 `work/feature-audit-report-2.10.1.json`。本版仍没有可编辑骨架原位热重载、原生时间轴控制或画面显示回执。

## 2.9.0 预览发布恢复和版本确认

序列资源更新现在先在图片监视目录外准备新图片与旧帧备份，再写入持久发布日志。全部图片、源工程和引用资源核对通过后才提交状态。写入失败会恢复上一组图片；进程中断后，后台工作进程在读取新输入之前先恢复未提交的发布。已提交但尚未清理日志的发布保留新图片。若核对发现图片或备份被外部改动，恢复会明确失败并保留日志与备份供检查；这不是对其它文件写入程序的排他锁。备份最多 128 MiB，日志最多 8 MiB；它们位于专用预览会话目录，不回写源工程或源图片。

新增 `spine_wait_native_preview`，将编辑工具返回的 `nativePreview.sessions[].generation` 交给它，即可等待该次更新。省略 `generation` 时固定本次调用开始时的待发布代数；可指定 `sourceSha256` 固定源版本。`waitMs` 默认 10000，范围 0–30000；它限制轮询等待，当前本机文件核对可能在期限后结束。最多核对 10000 个引用资源。

```json
{
  "id": "实际预览 UUID",
  "options": { "generation": 2, "waitMs": 15000 }
}
```

只有源文件、引用资源、原生预览工程和完整 PNG 组与已发布版本匹配，且核对前后状态稳定、没有待恢复日志时，才返回 `outcome: "published"`。返回的 `sourceVerified`、`resourcesVerified`、`imageSetVerified` 和 `projectVerified` 表示这些保存字节核对；`editorDisplayAcknowledged` 和 `editorProjectReloaded` 仍为 `false`。其它结果包括 `timeout`、`superseded`、`error`、`stopped`、`expired`、`source_changed` 和 `unverified`。较新的请求会使旧代数返回 `superseded`，不推断历史画面；旧会话缺少版本证据时返回 `unverified`，更新或续期后再查。该工具只读，不续期、不切换分支、不打开编辑器，实验单图连续播放不支持此回执。

恢复保证针对保存的资源文件，不是 Spine 窗口中同时切换全部纹理。实际更新或恢复过程中仍可能短暂看到 Loading 或混合画面；恢复成功后整组文件一致。原生可编辑骨架热重载、时间轴控制和未保存内存访问仍未实现。

未激活的附件如果仍引用缺图，也会阻止 `resourcesVerified` 通过；可显示的当前姿势不代表整份资源清单完整。完整回归及工具覆盖报告为 `work/feature-audit-report-2.9.0.json`，成功路径覆盖不表示全部参数组合已穷尽。

`npm run smoke:preview-publication` 用实际 MCP/CLI 创建独立测试预览，验证编辑后的指定代数回执、旧请求被替代、源哈希不匹配，以及实际辅助进程在第一次替换图片后退出时的后台恢复。测试不打开 GUI、不操作已有编辑器。故障注入单元测试还覆盖临时写入锁、回滚失败后重试、外部冲突、备份及发布清理阶段。

## 2.8.0 复杂角色、像素诊断和增量预览

- `spine_bake_foot_contacts` 新增显式 `constraintMode: "bake"`：先捕获交互约束产生的完整姿态、插槽、换图和变形，再在新动作里校正脚底。保留原骨架和原动作，仅在新动作关闭约束混合；与默认无约束模式不同，新动作中的其它通道会被采样烘焙。双倍 FPS 加关键帧/接触边界核对脚底、鞋子方向、非接触期和未受影响骨骼的世界变换。仍要求直接两段链、正向均匀缩放、正常继承和明确参考弯曲；不支持的姿态或超差会拒绝输出。
- `spine_audit_animation.options.meshVisibility: "pixels"` 在明确的 `visibilityPixelSize`（世界单位，默认 1）下逐网格中心检查三角形覆盖、纹理透明度、裁剪和后绘制不透明图层。默认最多 50000 个网格单元，`maxVisibilityPixels` 上限 2000000；另外保留几何/三角形测试预算。重心被遮住而边缘露出的翻折仍告警，细小到没有像素中心覆盖的候选也保留。报告列出像素计数和 `marked-regions.png`，图片是异常三角形的局部几何诊断图；有限分辨率不构成连续几何、GPU 或人体自然度证明。
- 新工具 `spine_save_character_template` 保存经过源骨架校验的 JSON 数据配方；`spine_apply_character_template` 通过骨骼角色、眨眼插槽/附件别名、次级摆动和接触时间窗口应用到目标角色。支持明确的时间与平移缩放，按需烘焙接触，一次只发布一个新 JSON；不推断人体解剖。模板的接触窗口不保存绝对坐标，锚点在目标姿态重新解析。保存文件上限 8 MiB，已有输出不覆盖。
- 原生序列预览默认仍为 120 帧，显式 `sequence.maxFrames` 可提高至 600；`chunkFrames` 默认 30，范围 1–120。仍限制 6400 万输出像素、64 MiB 缓存、20 万骨骼和 3 万插槽采样，以及 800 万几何顶点指纹采样。每帧按实际几何、裁剪、颜色、当前 PNG 字节和固定视口计算指纹，复用旧帧并去重相同姿势；只有内容变化的目标 PNG 才替换。更改视口可能使所有帧失效。报告提供 `renderedFrames`、`reusedFrames`、`deduplicatedFrames`、`publishedChangedFrames`、分段计数和耗时。这里的分段是后台准备/缓存记录，Spine 仍预加载整段；多文件更新不是原生原子事务，资源更新时仍可能短暂 Loading。
- 图片序列附件上限提高至 600；CPU 预览只解码指定时刻用到的图片，单次仍最多 128 张活动 PNG、64 MiB 文件和 6400 万图片像素。不会因为一段长序列包含超过 128 帧而拒绝少数时刻的预览。

正式角色动作集为 `01_idle_breeze`、`02_greeting_wave`、`03_charge_release`、`05_jump_land_review`，均已有用户对当前原生工程版本的明确认可；旧 `04_jump_land` 留作归档，不纳入正式集。原生文件和 12 张源图保持不变，记录见 `work/formal-animation-review-2.8.0/formal-set-acceptance.json`。

`npm run smoke:quality` 用实际 MCP/CLI 验证约束脚底固定、模板保存/应用、边缘可见的像素告警、150 帧原生序列往返、局部重建和无关修改零图片写入。`npm run audit:features` 对全部工具生成成功/拒绝调用覆盖矩阵，运行前后核对源文件集合与哈希；源版本变化会使本轮失败。2.7 的 32 套基线回归已覆盖 144/144 工具；当前版本的报告路径为 `work/feature-audit-report-2.8.0.json`。成功路径覆盖不代表穷尽全部参数组合。

参数示例：`examples/character-template-save.json`、`examples/character-template-apply.json`、`examples/quality-pixel-audit.json`、`examples/native-sequence-long.json`。示例路径和角色别名需换成目标工程的明确映射。

## 2.7.0 诊断、验收和任务恢复

新增 `spine_recover_job`，统一查询、继续排队任务、识别已退出的工作进程，并对失败/取消任务创建可追踪的替代任务。同一个 `recoveryId`（默认原任务 ID）最多创建一个替代任务，断开重连或丢失响应后重复调用仍会返回它；不会重复正在运行的任务。替代任务也失败时，需要明确的新 `recoveryId` 或恢复替代任务本身。已经成功的结果只按历史记录返回，不重新验证文件，也不再次打开编辑器。通用操作读当前保存输入；已有不确定输出必须指定新路径。原生发布仅在保留发布请求 ID 且独立核对通过后复用原输出。

`spine_audit_animation.options` 新增 `physics`（默认 false）、`physicsFps`（1–120，默认 60）、`meshVisibility`（默认 `geometry`）。物理从零重置后沿物理帧网格和精确采样/接触边界持续积分；报告实际积分步数，接触锚点用独立的顺序采样器。上限为从零 6000 步及合计 500000 骨骼积分步；非整帧采样安排可能影响结果。异常预览独立从零模拟，不代替连续多轮物理收敛测试。

`meshVisibility: "centroid"` 对翻折三角形的变形后重心补查普通/反向裁剪及后方绘制的不透明 normal 图层。透明、半透明和 additive/multiply/screen 图层不会遮掉候选。该模式仅检查重心，无法证明整个三角形不可见，也不检查同一网格的自遮挡；`geometryFoldCandidates`、`hiddenMeshFoldCandidates` 和 `filteredFindings` 保留所有候选及分类依据，`allGeometryNoFold` 独立报告。默认 `geometry` 模式保留全部翻折告警。

视觉记录新增可选 `animations: ["05_jump_land_review"]`；省略时明确记录整份工程的审阅。查询也支持动作筛选。只通过部分动作时，全工程返回 `partial`，其它动作仍为 `pending`；源文件或资源变化会使验收失效。回归交付条件不会把 `partial` 当成整份通过。2.7 当时仅确认修订动作；2.8 的正式动作集验收状态见上节。记录见 `work/visual-acceptance-2.7.0/workflow-verification.json`。

## 制作、验证和交付

| 新工具 | 功能和验收边界 |
| --- | --- |
| `spine_recover_job` | 查询/继续原任务或以稳定恢复 ID 创建一个替代任务；保留中断产物，不覆盖不确定输出，不打断存活工作进程。 |
| `spine_check_environment` | 检查可信 CLI/编辑器入口；`probeCli=true` 验证实际版本。每次执行前重新发现临时运行目录；固定配置路径失效时明确报错。 |
| `spine_publish_and_open` | 已保存的单骨架 JSON/工程 → 资源预检 → 可选编辑 → 原生导入、导出核对 → 新 `.spine` → 可选打开。默认打开新实例，可能改变窗口焦点。 |
| `spine_get_publication` | 查询持久化阶段、失败阶段、输出哈希和编辑器打开记录。稳定 `requestId` 支持恢复并避免重复打开；中断留下的输出必须独立核对后才能复用。 |
| `spine_audit_animation` | 按明确规则检查接触期滑脚、关节角度、肢体间距/交叉、相邻采样突变、网格翻面；输出异常时间、数值和预览。 |
| `spine_prepare_character` | 根据明确的骨骼位置与分组，把选定分层图片转为网格并绑定权重；保留设置姿态与原 PNG，写入新 JSON。 |
| `spine_build_pose_animation` | 稀疏姿势、平滑/线性/阶跃曲线、限幅延迟摆动和眨眼窗口生成新动作；保留已有动作。 |
| `spine_bake_foot_contacts` | 为新动作烘焙明确接触区间的两段腿链，保持鞋子朝向，并以双倍 FPS 加原关键帧/接触边界核对。 |
| `spine_run_regression_suite` | 运行可固定源文件及完整资源哈希的案例，选择原生往返与动作规则，保存逐项报告。 |
| `spine_record_visual_review` | 记录调用方明确提供的视觉通过/拒绝、说明和本地证据；绑定源文件与全部引用资源版本。 |
| `spine_get_acceptance` | 查询当前版本视觉记录；改动源文件或图片后，旧验收自动失效。 |

一键交付参数示例（路径均相对配置的 workspace，输出必须不存在）：

```json
{
  "requestId": "1f755bb5-75b3-4e3c-9429-e8974eb29c5b",
  "input": "character/animation.json",
  "output": "deliveries/character-reviewed.spine",
  "edits": [],
  "openInEditor": true,
  "reuseInstance": false
}
```

同一次请求重试应保留 `requestId`；换源版本、参数或输出时生成新 UUID。源工程、旧资源、新引用图片和跨工程依赖都会检查哈希。构建成功但启动失败时保留已验证工程，查询报告后可重试打开。没有使用客户端重连触发重复 GUI 启动。

`spine_start_job` 新增 `publish_and_open`、`audit_animation`、`regression_suite` 三种持久后台操作；提交后可断开 MCP，用 `spine_get_job` 查询。同一发布任务的重试保留发布 UUID。人工取消在阶段边界生效；运行中的 CLI 步骤可能先完成。具体工具参数见 MCP schema 和 `examples/stability-workflows.json`。

诊断的距离单位为骨架世界单位，关节限位为相对设置姿态的角度；接触时间需明确指定。网格透明度结合骨架、插槽、附件和 UV 三角形重心纹理透明度；默认不判断裁剪/遮挡；可选择上文的重心可见性分类及物理采样，刻意折叠的三角形仍需视觉复核。无异常只表示所配置的采样规则通过，不能证明人体动作自然。脚底烘焙只支持无约束、正常继承、正向均匀缩放、带参考膝盖弯曲的直接 `upper > lower > foot` 链；不可达目标、翻转/剪切或超出容限会拒绝发布。默认位置容限 0.1，鞋子朝向容限 0.1 度，可分别指定。

回归报告中 `checksPassed` 表示所请求的结构、资源、原生和数值检查通过；`visualAcceptance` 单独报告 `pending` / `reported_rejected` / `reported_accepted`；`releaseReady` 仅在检查全部通过且当前版本全部有调用方报告的视觉通过记录时为真。自动测试不会代替用户给角色做视觉验收。

原生曲线核对支持 Spine 对恒定/近恒定通道的归一化：通过 Bezier 纵向控制点凸包限制整段误差，逐分量报告最大界，阈值为端点尺度的 `2e-5`；端点、非恒定曲线和其他结构检查保持原严格规则。导入可将编辑器 FPS 元数据提高到不超过 240 的兼容网格；不会改写原动作关键帧时间。原生导出中的空/`null` 资源根目录先相对原工程解析，再移动 JSON。

本版仍没有原生播放/暂停/跳转时间轴、选择动作、读取未保存内存或可编辑骨架原位热重载。已保存工程的一键构建打开和独立序列预览仍可用。核对依据为 [官方 CLI](https://esotericsoftware.com/spine-command-line-interface)、[实例设置](https://esotericsoftware.com/spine-settings) 和 [图片监视说明](https://esotericsoftware.com/spine-images)；这些文档未建立本安装可用的编辑器内控制接口。详见 `RESEARCH.json`。

验证：`npm test`；`npm run smoke:stability` 使用当前构建的新 MCP 连接，验证 11 个制作/稳定性工具、真实 CLI 往返、重复请求、后台任务跨断开继续与显式恢复、按动作验收、物理与可见性诊断、滑脚检测与修正。若 workspace 有当前动漫角色，将额外核对四组动作；否则报告明确标记未包含该角色。若存在官方 Spineboy，还会检查运行时动作，以及单独记录原生导入凹裁剪不兼容被拒绝的负向结果；该拒绝不计为原生兼容通过。`npm run smoke:productization` 验证干净依赖安装和含空格目录搬迁；不会打开 GUI。

## 2.5.0 创建工程并打开编辑器

`spine_create_project` 创建带 root 骨骼的新 `.spine` 工程和同级 `images` 目录，支持 `output`、`skeletonName`、`fps`（1–240，默认 30）。原生导入、重新导出和结构核对通过后才发布；已有输出不会被覆盖。默认只创建文件，显式设 `openInEditor: true` 可在创建后打开编辑器。打开失败时仍返回已经创建的工程及错误，修正配置后可直接调用 `spine_open_project`，无需重建。

`spine_open_project` 接受工作目录内已保存的 `.spine`，不需要批处理 CLI。默认以 `--no-reuse-instance` 请求新窗口；`reuseInstance: true` 显式请求复用实例，可能触发未保存内容提示。MCP 不代替用户关闭提示。打开进程独立于 MCP，不使用 CLI 的超时结束逻辑；断开 MCP 不关闭编辑器，也不发送鼠标、键盘或窗口激活命令。Spine 自身仍可能激活新窗口。

打开结果包含持久请求 `id`、`launchAccepted`、`windowObserved`、窗口标题和 `projectWindowTitleMatched`。`spine_get_editor_open_status` 可在重连后查询。传入同一个 `requestId` 重试只查询原请求，不重复启动；不同工程、文件版本或复用模式不能共用该 ID。启动失败也不会自动重试。窗口标题匹配只证明观察到了对应标题，`projectLoadedVerified` 始终为 false：工具没有编辑器内数据回执，不读取未保存状态，也没有实现原工程热重载。

编辑器入口使用 `guiExecutable`。如果安装程序每次解包到新的本地目录，可配置 `guiRuntimeDiscovery: { root, directoryPrefix, entrypoint }`，发现方式与 CLI 相同；配置后优先使用发现到的运行入口，找不到时明确失败。`setup --gui Spine.exe` 显式改用固定入口，移除迁移配置中的 GUI 动态发现。可用 `npm run setup -- --config OLD.json --output NEW.json --gui "C:/Program Files/Spine/Spine.exe"` 生成新配置；带空格的参数请按所用 shell 正确加引号。

示例参数见 `examples/create-and-open-project.json` 和 `examples/open-project.json`。通过 `npm run call -- spine_create_project --args-file examples/create-and-open-project.json` 调用已注册的服务。后续已有工程的编辑、导入或构建完成后，也可将结果路径交给 `spine_open_project`。

`npm run smoke:editor-project` 运行实际 MCP 创建、原生往返、图片路径、FPS、已有输出和无效输入检查，不弹出窗口。增加 `-- --open` 才做真实打开测试，并检查同 ID 重试和 MCP 重连。报告分别为 `work/editor-project-report-2.5.0.json` 和 `work/editor-open-report-2.5.0.json`。本机已通过创建和打开测试，用户确认看到了新工程与 root 骨骼；人工验收与程序窗口证据分别记录。

## 2.4.1 预览渲染提速

纯图片图层和无文字的 clean 预览不再重复扫描系统字体；带文字的预览仍正常加载字体。优化不改变骨骼计算、网格、混合模式、PNG 尺寸、序列区间或原生播放时钟。`npm run smoke:preview-performance` 使用当前 Spineboy 序列会话，比较优化前后的 PNG 字节和 MCP 编辑到整组序列发布的耗时，最后精确恢复原画面。该本机检查需要已有 2.4.0 基线报告；不代表任意工程的性能或窗口效果。

本机官方 Spineboy 的同一次半尺寸编辑（20 帧、512×512）从 43.6 秒降至 6.8 秒；恢复正常尺寸重建约 12.4 秒。两组共 40 帧及透明、非透明、带文字的四个渲染样本都与 2.4.0 的 PNG 字节一致，原工程和 43 个官方文件保持不变。测量包括 MCP 编辑到完整序列发布，不是原生窗口帧率，也不代表所有工程的耗时。结果见 `work/native-preview-performance-report-2.4.1.json`。

## 2.4 原生序列帧预览

连续动画改用 `spine_start_native_sequence_preview`，参数示例：`{input, options:{animation:"run",width:512,height:512}, sequence:{nativeFps:30}}`。它先生成全部帧，再创建含 `MCP-playback` 动画的 `MCP-sequence.spine`。

在 Spine 打开新工程一次，切到 ANIMATE，展开 Animations，并点击 MCP-playback 那一行最左侧的小圆点来激活动画。仅选中名称不会激活；然后启用循环并启动播放。之后 Spine 自己切换预加载的帧，**稳定播放期间后台不写图片**。保存数据或资源变化后，后台先完成整组新帧，再替换既有资源；实际更新期间仍可能短暂出现 Loading，不能保证多文件同时在窗口中切换。

原生播放、暂停、跳转和速度仍使用 Spine 时间轴控件，MCP 无法控制或读取该时钟。`spine_stop_native_preview` 只停止资源同步，不停止已经在 Spine 播放的动画。`spine_update_native_preview` 可修改输入、动画、皮肤、物理及取景；序列会话会拒绝 `time` 参数和实验单图时钟控制。帧数、原生帧率和区间在创建时固定；改变这些条件需创建新的序列预览。最多 120 帧、6400 万输出像素和 64 MiB 缓存。

`npm run smoke:native-sequence` 验证实际 4.3.23 序列与动画读回、资源引用、序列逐帧采样、稳定期间无图片写入、编辑更新、缺帧恢复和同工程恢复。窗口显示另外验收。

## 实验单图时钟

以下高频替换单个 PNG 的方案已进行两次窗口测试，均出现 Spine 的 LOADING 占位图，**连续播放质量验收未通过**。临时文件移出图片目录、PNG 等长处理也未消除该现象。该入口保留为实验能力；单帧编辑后刷新仍可使用，连续动画优先选择上面的原生序列方案。

新增 `spine_control_native_playback`，在**同一个专用 Spine 预览工程**内发布缓存动画帧，不必再打开新工程。先用 `spine_update_native_preview` 选定动画，再发送：

```json
{
  "id": "实际预览 ID",
  "control": {"action":"play", "start":0, "end":0.6666667, "playbackFps":8, "speed":1, "loop":true}
}
```

- `play`：开始或恢复；默认区间为整个动画、8 FPS、1 倍速、循环。配置区间时从起点开始；可用 `time` 指定起播时间。
- `pause`：固定最后已发布的画面。
- `seek`：必须提供区间内的 `time`，保持原先的播放/暂停状态；画面取不晚于目标时间的缓存采样帧。
- `stop`：停止动画，恢复 `spine_update_native_preview` 设置的静态姿势。停止整个后台会话使用 `spine_stop_native_preview`。

`playbackFps` 允许 1–24，表示后台 PNG 发布目标；`speed` 允许 0.1–4。原有 `options.fps` 仍用于物理模拟采样，和播放帧率分开。播放使用独立时钟，不控制 Spine 原生时间轴，没有音频。Spine 图片监听可能合并频繁更新；**PNG 发布速度不能代替窗口实际帧率或流畅度验收**。连续播放的窗口验收与已有单帧刷新验收分别记录。

初次播放先准备完整缓存；长度和复杂度决定准备时间。普通 MCP 编辑、动画/皮肤/物理/取景改变和纯资源更新会使缓存失效；重建期间保留最后有效画面，完成后再继续。暂停、跳转、循环和变速可复用相同采样缓存。每个缓存最多 120 帧、6400 万输出像素、64 MiB，并受骨骼/插槽/物理预算约束；重建时旧缓存与新缓存暂时并存，完成后清理旧缓存。缩短区间或降低帧率/尺寸可以减少准备耗时。

播放请求持久保存，断开 MCP 后继续，仍遵守会话到期/停止条件。渲染进程恢复时验证磁盘缓存哈希，从最后已提交的帧继续；不会把中断时间算入播放进度，已经播完的非循环片段也不会自行重播。损坏或旧版本缓存重新生成。

查询 `spine_get_native_preview` 的 `requestedPlayback`、`playback.state`、`currentTime`、`cacheFrames`、`cachedFrames`、`cacheBuildMs`、`cacheBytes`、`publishedFrames` 和 `skippedFrames`；请求代数相等且状态为 playing/paused/completed 表示相应画面已发布。后台时钟采用丢帧追赶，不积累待播放队列；采样率和输出上限会影响快速播放效果。

`npm run smoke:native-playback` 在独立测试工程通过 MCP 测量 4/8/12/24 FPS 发布、播放控制、编辑与资源失效、重连、缓存复用和静态恢复。`npm run check:native-playback-current` 是单独的本机人工验收入口：临时使用当前预览 ID 测试 Spineboy，并提供 120 秒的 8 FPS 观察窗口，随后校验并恢复原 PNG、源数据和工程；不会自动计入窗口验收。示例见 `examples/native-playback.json`。

## 2.3 预览续期、恢复与连续验证

提供八个入口（含 2.4 原生序列与实验单图时钟）：

| 工具 | 用途 |
|---|---|
| `spine_start_native_preview` | 从保存的工程/JSON 生成专用 `.spine` 预览工程、固定 PNG 和后台更新进程 |
| `spine_get_native_preview` | 查询请求代数、已发布代数、贴图修订、哈希、耗时、错误和路径 |
| `spine_list_native_previews` | 查找活动和历史预览 |
| `spine_update_native_preview` | 更换输入分支、采样动画/时间/皮肤/物理选项，或 `refit=true` 重新取景 |
| `spine_stop_native_preview` | 合作停止更新，保留工程与最后画面，不关闭 Spine |
| `spine_resume_native_preview` | 同一 ID 和工程续期，或恢复停止、到期、失败及中断的预览 |
| `spine_control_native_playback` | 实验单图时钟，窗口连续播放验收未通过 |
| `spine_start_native_sequence_preview` | 预加载图片序列与原生动画；稳定播放时不写图片 |

首次把返回的 `project` 文件在 Spine 中打开一次。后续成功的 JSON/原生工程编辑会把输出路径通知预览进程；进程渲染选定姿势并原子更新 `images/preview.png`，由 [Spine 自身图片监听](https://en.esotericsoftware.com/spine-images) 重载画面。无需点击刷新、模拟输入或激活窗口。直接编辑、批量 edits、原生重建和独立后台编辑任务共用发布通知；原生工程导出的工作 JSON 也建立关联。连续修改合并到最新请求，发布前检查请求代数、源文件和资源哈希；过期、停止或旧渲染结果不会覆盖新请求。资源自身发生变化也会重新渲染。

这是**专用 Spine 工程中的图片预览**，可显示静态采样或缓存动画；不自动重新载入原骨架工程，也不读取或控制当前 Spine 时间轴。通过 MCP 选择动画、时间、皮肤；`animation=null` 返回设置姿势。贴图尺寸保持不变，默认保留初次取景，`refit` 可重新取景。预览工程本身创建后保持不变，原始工程也不被覆盖。原生预览工程只包含显示图片所需的根骨骼和插槽。

`generation` 表示 PNG 已按该请求发布，`pendingGeneration` 表示最新请求，`textureRevision` 包括纯资源变化引起的重绘。`editorDisplayAcknowledged=false` 和 `editorProjectReloaded=false` 是明确边界：Spine 没有提供画面已显示的回执，不能把 PNG 更新冒充窗口验收。渲染错误保留最后有效 PNG，并在状态返回 `lastError`。

进程在 MCP 断开后继续，默认 1 小时、单次最多 8 小时，同时最多 4 个活动预览；64–1024 像素的固定画布。使用 `spine_resume_native_preview({id, options:{durationSeconds:28800}})` 从当前时刻续期（参数模板见 `examples/native-preview-resume.json`，将示例 ID 换成实际预览 ID）；不传时长沿用上次配置。停止、到期或失败后也使用同一入口，原工程路径、PNG、画布、取景、动画、时间和皮肤保持不变，不必重新打开新工程。恢复会增加请求代数，轮询至 `generation === pendingGeneration`。初次创建记录原生工程哈希；旧版会话首次恢复时建立基线。文件缺失或基线之后工程被改动时会拒绝恢复，不会覆盖工程。创建原生预览需要已配置 CLI；后续 JSON 渲染由后台 CPU 完成。旧 MCP 连接需重新连接以获得新增工具。示例见 `examples/native-preview.json`。`npm run smoke:native-preview` 验证六个预览工具、真实原生项目资源引用、断开连接、导出别名、关键帧姿势、后台编辑任务、资源变化、错误恢复、停止与源文件哈希；报告为 `work/native-preview-report-2.3.0.json`。

渲染进程由另一个隐藏 Node 进程守护。异常退出按 1、2、4、8 秒退避，连续第五次失败后停止自动重启；进程稳定 20 秒会重置连续失败计数。显式恢复或新的编辑请求也会重置重试预算。守护进程自身中断后，下次 MCP 启动或编辑/更新/恢复请求会重新启动它，并接管仍在运行的渲染进程。停止和到期不会自动复活。`workerAlive`、`supervisorAlive`、`recovery`、`consecutiveRenderErrors`、`lastErrorAt` 和 `lastSuccessAt` 区分进程恢复与渲染错误。渲染失败保留最后有效图片，新请求可中断错误退避。Windows 临时文件锁采用有上限的原子替换重试；替换失败也保留旧文件。

`npm run smoke:native-preview-recovery` 实际中断隔离测试的 Node 渲染/守护进程，验证最新修改保留、五次失败上限、显式恢复、断开重连、到期恢复与停止/恢复竞争。`npm run smoke:native-preview-stability` 使用本机已打开的 Spineboy 预览 ID，连续执行 48 轮骨骼、关键帧、动画/时间和皮肤修改，以及独立图片变化、续期和重连；最终恢复原输入与逐字节相同的 PNG，核对官方原件的 43 个文件。该脚本需要 `work/current-native-preview.json` 和本机官方 Spineboy 路径，资源修改仅发生在测试副本。报告为 `work/native-preview-recovery-report-2.3.0.json` 和 `work/native-preview-stability-report-2.3.0.json`。

本轮还修复了复制含变形动画的默认皮肤时旧命名空间未迁移的问题：提升为命名皮肤时同时迁移变形/序列时间轴和隐含默认皮肤的链接网格引用；复制皮肤保留独立的动画键及内部链接关系。

2026-10-22 已完成本机 Spineboy 的窗口内人工验收：用户打开专用预览工程后，普通 MCP 骨骼修改触发 PNG 更新，用户确认“已自动变化，未手动刷新”。随后恢复 `run` 第 0.15 秒，PNG 哈希与测试前完全一致，源数据与预览工程文件未改变。报告为 `work/native-preview-visual-test-2.2.0.json`。这是专用工程单帧图片刷新通过，不代表原骨架、插槽或时间轴已热重载；程序状态中的两项回执仍保持 `false`。

原骨架工程自动重新载入尚未实现。本机检查没有找到能够指定目标实例、处理未保存内容、保持焦点与动画/时间/视图并返回编辑器状态的受支持入口。[官方 CLI 文档](https://en.esotericsoftware.com/spine-command-line-interface)提供保存文件的批处理和打开工程，[复用实例设置](https://en.esotericsoftware.com/spine-settings)描述文件打开行为；这些说明没有提供完整的后台重载协议。官方对[编辑器内部结构自动化](https://esotericsoftware.com/forum/d/29562-spine-cli--mcp-automation-and-json-round-trip)的答复仍建议在数据层导出、修改和导入。

运行 `npm run build` 后执行 `npm run check:native-reload`，可复查本机进程/端口/入口与 `reuseInstance` 设置，并在隔离副本中新增骨骼、插槽、动画和两帧旋转关键帧，构建原生工程再导出核对。结果写入 `work/native-reload-check-2.2.0.json`，明确区分磁盘数据验证与未验证的编辑器重载。这条检查不启动 GUI、不转发打开命令、不改设置，也不替换当前打开的工程。

## 2.1.1 验证与修复

本版保持 122 个工具。修复原生 JSON 时长舍入（例如 20/30 秒导出为 0.6666667）导致循环媒体多出帧的问题；默认编码 [start, end) 的采样点，显式 omitEndFrame=false 保留终点，300 帧预算按实际编码帧计算。PNG 帧导出仍保留独立的终点采样。

运行 `npm run audit:features` 会构建并执行 30 个验证套件，记录每次实际 MCP 调用的工具名、服务版本、输入摘要和结果，生成对应版本的 `work/feature-audit-report-<版本>.json`。逐工具矩阵只统计当前核心代码、且断言通过的套件中的成功调用；错误输入拒绝单独记录。没有调用、调用失败或套件失败均不能计为通过。支持 `--directory` 指定报告目录，`--only` 重跑指定套件，`--resume` 复用同一目录中当前核心代码下已通过的结果；核心代码改变后，旧结果不计入覆盖。

完整核对在源码目录运行，需要通过 `npm ci` 安装开发依赖，并配置本机 4.3.23 CLI、FFmpeg/FFprobe、`work/official-examples/examples` 下的四个官方示例，以及选定的官方 Spineboy Pro 工程路径（现有会话记录或 `SPINE_AUDIT_USER_PROJECT` 环境变量）。缺少这些输入时相应套件会失败，不会自动算作通过。普通工具的使用范围仍以各工具说明为准。

`user-project-smoke` 对用户选定的本机官方 Spineboy 工程创建副本，逐个动画检查原生往返和画面采样，并用原始小数时长验证 APNG/GIF/MP4/精灵图。源目录所有文件执行前后核对哈希。可通过 `SPINE_AUDIT_USER_PROJECT` 指定另一份保存的 Spineboy Pro；其中 20 帧的时长回归针对该官方示例，不能当作任意生产工程的通用验收器。`entrypoints-smoke` 在独立队列工作区验证独立编辑入口、原生重建、取消和恢复，并检查必填参数缺失的拒绝行为。

覆盖 122 个工具的基本成功路径不等于穷尽全部参数组合、连续时间误差或编辑器专有信息；各项目原生格式限制仍适用。

## 2.1 保存后自动同步

| 入口 | 用途 |
|---|---|
| `spine_start_saved_sync` | 监听一个已保存 `.spine` 或 Spine JSON，以及全部骨架引用的图片/音频；同一路径已有活动监听时返回原 ID |
| `spine_get_saved_sync` | 查询心跳、状态、错误、到期时间、快照列表与哈希 |
| `spine_list_saved_sync` | 列出活动和历史监听 |
| `spine_stop_saved_sync` | 请求停止，保留已生成快照；当前 CLI 步骤可先完成 |
| `spine_resume_saved_sync` | 恢复停止、到期、失败或中断的监听，保留已有快照和最后内容指纹；达到上限时需明确提高上限 |

示例见 `examples/saved-sync.json`。首次稳定输入可生成初始快照；后续保存工程或单独修改贴图/音频都会触发。默认每 2 秒检查文件状态，连续稳定 1.5 秒后处理，每 30 秒完整核对内容哈希；仅触碰时间戳但内容不变不会重复发布快照。工程内容变化后重新发现资源；原生工程覆盖全部导出骨架和皮肤。JSON 监听及存档不需要 CLI，原生 `.spine` 需要已配置的 4.3.23 CLI。

后台 worker 独立于 MCP 连接，关闭客户端后仍可运行。缺文件或不完整保存会等待并退避重试，连续 20 次失败后停止，错误可查询。每份快照包含字节不变的原文件、便携 JSON 预览、图片/音频和哈希清单。发布前后再次核对输入；保存中变化的捕获保留为未发布归档，供检查。先持久化快照提交记录，再更新状态；恢复时校验提交归档并补齐状态，避免因状态写入中断而重复发布。

默认运行 1 小时、最多 20 个快照和 512 MiB 已记录归档。最多同时监听 8 个路径；单个监听最多 100 个快照、输入资源最多 1 GiB/10,000 个文件。时限和存储上限按阶段检查，正在生成的一份归档可能使记录总量超出上限；CLI 临时导出另计。达到上限后停止，不自动删除文件。MCP 的 `stop` 请求不会终止 Spine 编辑器；worker 正在进行的 CLI 调用可先完成。

这是**保存后同步**，不读取编辑器未保存的内存，也不替用户触发保存。监听不会回写源工程、源图片或音频。使用 `spine_verify_archive` 可校验搬移后的快照；`.json` 原件只含已导出的数据，`.spine` 原件才保留原生编辑器信息。

`npm run smoke:saved-sync` 通过实际注册 MCP 启动原生工程监听，断开/重连客户端，模拟测试副本保存及图片独立变更，验证快照、搬移、停止和恢复。报告为 `work/saved-sync-report-2.1.1.json`；临时测试文件位于隔离目录。

## 2.0 动作处理、媒体与存档

| 功能 | MCP 入口 | 行为 |
|---|---|---|
| 动作重定向 | `spine_plan_retarget`、`spine_retarget_animation` | 精确/规范化名称匹配、显式映射、匹配祖先间的变换、不同设置比例与根位移缩放；允许目标中间辅助骨骼，歧义及倒置祖先关系拒绝 |
| 世界镜像 | `spine_world_mirror` | 世界轴与支点、左右骨骼交换、选定骨骼；输出新动画并保留采样时未选骨骼的世界运动 |
| 动画叠层 | `spine_compose_animation` | 重叠覆盖/叠加、骨骼/槽位遮罩、权重与淡入淡出、循环/速度、事件与离散通道阈值 |
| 质量与约束 | `spine_bake_constraints`、`spine_compare_animations_adaptive`、`spine_simplify_animation_adaptive`、`spine_check_physics_cycles` | 完整交互约束烘焙（包括非骨骼 Slider）、关键帧与递归采样核对、失败时保留原键、连续物理历史的多轮收敛检测 |
| 媒体 | `spine_media_status`、`spine_export_media` | 固定视口 CPU PNG 帧 + FFmpeg/FFprobe，后台 APNG/GIF/MP4/分页精灵图；帧数核对与资源哈希；队列和工作流均支持 |
| 原工程存档 | `spine_archive_project`、`spine_verify_archive` | 字节不变的原 `.spine` 或 JSON、便携 JSON 预览与资源、文件哈希和搬移校验；原生工程覆盖全部骨架 |
| 裁剪视觉替代 | `spine_bake_clipping`、`spine_compare_artwork` | 官方运行时采样裁剪，以普通三角网格和换图输出专用平面骨架；可跨不同骨架做同视口像素核对 |

`retarget_animation`、`world_mirror`、`compose_animation`、`bake_constraints`、`simplify_animation_adaptive`、`bake_clipping` 也接入统一 `edits`，可用于预检、原生回写、多骨架和后台任务。示例见 `examples/advanced-animation.json` 与 `examples/background-media.json`。`npm run smoke:complete` 调用全部 14 个新工具并验证原生回导；`npm run smoke:media` 验证编码、断开客户端后任务继续执行。报告见 `work/complete-report-2.1.1.json` 和 `work/media-report-2.1.1.json`。

动作烘焙按指定 FPS 加原关键帧采样，保存骨骼、槽位颜色、附件、序列、变形和绘制顺序，并只在新动画中关闭约束混合。同一名义时刻的二进制/JSON 浮点时间若相差不超过一微秒，合并为一个采样点，保留时间零；连续密集时间簇跨度超过一微秒时拒绝。重定向仅迁移动作，不复制源附件与事件，也不自动求解脚部接触。自适应检查在预算或深度不足时报告未通过；采样通过不能证明任意连续时间都在误差内。物理多轮检测保留模拟历史，报告有限轮次的实际误差，不能证明无限循环稳定。

凹裁剪替代输出只保留选定皮肤和动画的采样画面，**不保留原骨架、其它动画/皮肤及可编辑裁剪形状**。普通原生回写仍拒绝被导入器改变的凹裁剪；导入器本身尚未修复。先存档，再选择此工具生成独立视觉输出。原工程存档保留所有原始字节及编辑器信息，但原 `.spine` 内部路径不变；便携路径用于收集的 JSON 预览。修改后重导入不能证明编辑器专有元数据无损。

未保存编辑器内容仍无受支持的读取/写入接口。官方依据、研究结论与限制见 `RESEARCH.json`、`SUPPORT.json`。用户已明确没有可用生产工程，因此本次验收覆盖隔离用例和官方样例，用户生产工程验收保留为未完成。

FFmpeg 和 FFprobe 需本机安装；缺省从服务进程 PATH 查找，也可在配置中指定 `ffmpegExecutable` / `ffprobeExecutable` 的本地路径（相对路径按配置目录解析），例如：

```powershell
npm run setup -- --config spine.local.json --output spine.media.json --ffmpeg C:/tools/ffmpeg.exe --ffprobe C:/tools/ffprobe.exe
```

编码不会启动 Spine 的原生视频导出或抢占窗口。媒体默认输出干净画面和透明背景，省去预览中的标题、时间与边框；可用 `width` / `height` 指定尺寸，或 `transparent=false` 使用不透明深色背景。GIF 有调色板及二值透明限制，MP4 使用有损 H.264、无透明通道（透明区域变黑），尺寸须为偶数；APNG 和 PNG 精灵图保留透明。默认在精确帧边界去掉重复终帧；最终时长为实际帧数/FPS，未整除的区间按帧离散。每次最多 300 帧、单帧约 200 万像素、总计 6400 万输出像素；单个媒体文件 64 MiB，总输出 128 MiB。精灵图页最多 8192 边长/1600 万像素。媒体输出仅接收 `kind=artwork`；骨骼示意使用 `spine_export_frames`。

## 1.1 表面迁移与兼容诊断

- `spine_transfer_weights` 新增 `method=surface`：在设置世界坐标中寻找最近三角形表面，以重心坐标插值权重。`maxDistance` 用世界单位限制匹配距离；可与骨骼映射、目标槽位局部镜像及锁定权重组合。默认仍为 `nearest-vertex`。`minWeight=0` 保留全部正权重；显式给出正阈值时，清除较小的未锁定权重并重新归一化。原生导入会量化微小权重，反复迁移后出现核对不一致时可显式选择如 `minWeight=0.00001`，预检差异可供检查。超过 16 根保留影响时拒绝；同距离重叠表面取源三角形顺序中的第一项。每次最多五百万次比较。
- `spine_replace_mesh_topology` 新增 `deformPolicy=interpolate`：通过旧 UV 面迁移权重、绑定坐标、源与链接网格变形。适合保留 UV 对应关系的网格编辑；不是不同 UV 展开或任意重拓扑的无损转换。
- `spine_check_native_compatibility` 报告当前目标版本的裁剪导入风险；`spine_preflight_edits` 的返回值与报告新增 `nativeCompatibility`。诊断不能替代原生导入、导出核对。

调用示例见 `examples/surface-transfer.json` 和 `examples/surface-retopology.json`；`npm run smoke:surface` 通过已注册 MCP 验证插值迁移、独立链接变形、原生工程编辑、持久后台队列以及拒绝发布错误凹裁剪。报告为 `work/surface-report-2.1.1.json`。

## 1.0 功能与验收

| 阶段 | 新增入口 | 行为 |
|---|---|---|
| 工程预检 | `spine_preflight_edits`、`spine_audit_assets`、`spine_relink_assets`、`spine_collect_assets` | 内存预演、JSON Pointer 差异、缺图/序列缺帧/音频/重复与未引用资源报告、资源重定位和带哈希的便携资源包 |
| 关键帧 | `spine_edit_keyframes`、`spine_edit_curves`、`spine_insert_boundary_keys`、`spine_paste_keyframes`、`spine_key_pose` | 按时间、索引或事件名称增删改；显式冲突策略；曲线修改；区间粘贴；边界插键；未受约束的局部姿态插键 |
| 跨工程复用 | `spine_transfer_animation`、`spine_transfer_rig`、`spine_merge_skins` | 跨 JSON 文件名称映射、兼容变形影响重排、骨架分支及闭合依赖迁移、皮肤合并冲突策略 |
| 网格与蒙皮 | `spine_trace_contours`、`spine_mesh_from_contours`、`spine_edit_mesh_vertices`、`spine_refine_selected_triangles`、`spine_replace_mesh_topology`、`spine_transfer_weights`、`spine_check_mesh_intersections` | 凹轮廓/孔洞/独立岛屿、逐顶点与 UV 编辑、局部重心细分并保留变形、可选 UV 插值迁移变形的拓扑替换、最近顶点/三角形表面权重镜像与转移、锁定影响权重、UV 相交检查 |
| 动画与交付 | `spine_check_visual_loop`、`spine_compare_projects`、`spine_simplify_animation`、`spine_selective_bake`、`spine_pack_atlas_configured`、`spine_unpack_atlas`、`spine_deliver`、`spine_verify_package` | 采样世界几何、颜色、绘制顺序和接缝速度；数值通道减帧；选择性约束烘焙；图集设置与解包；原生核对后的完整交付与搬移校验 |
| 安装与稳定性 | `spine_run_pipeline`、`spine_retry_job`、`npm run setup`、`npm run release`、`npm run benchmark` | DAG 依赖校验、进程锁、逐阶段检查点、输入/资源/结果哈希核对后复用；失败任务新建重试；配置迁移、可搬移发布目录和性能报告 |

16 种新编辑也都可作为 `spine_apply_edits` / `spine_edit_project` / 多骨架构建 / 后台任务中的 `edits` 使用，`type` 为相应工具名去掉 `spine_`。跨工程编辑的 `source` 为工作目录内已保存的 JSON；`.spine` 可先用 `spine_inspect` 导出，使用其 `workingJson`。

重要边界：

- `insert_boundary_keys` 默认 `mode=runtime`，以运行时的原始折线为依据增加支撑关键帧；为避免 4.3.23 导入时将邻近整帧的时间吸附，新输出的时间轴 FPS 至少设为 240。关键帧仍用秒表示，动画时长不变，预检会显示 FPS 修改。`mode=curve` 使用 de Casteljau 拆分数学 Bezier，运行时离散近似可能变化。颜色仍受 8 位量化限制。
- `mesh_from_contours` 默认 `representation=compound`：多个普通网格与槽位共同表达孔洞和岛屿，复制相关换图、颜色与绘制顺序。最多 500 个片段、10,000 个轮廓顶点。`single-mesh` 适用于运行时 JSON；编辑器会重建单一外边界，原生回写无法保持时会拒绝发布。
- 变形迁移要求兼容拓扑与骨骼影响；骨架分支迁移保留局部设置坐标，依赖必须位于所选分支内；导入分支的绘制顺序和音频路径会投影与重定位。不同骨架动作重定向使用独立的 `spine_plan_retarget` / `spine_retarget_animation`。
- 拓扑替换默认拒绝丢弃变形。`deformPolicy=interpolate` 按旧 UV 三角形推导新权重，并迁移源与独立链接网格的稀疏变形关键帧及曲线；提供未加权的新设置位置。超出旧 UV 面、重叠 UV 对应歧义和超过 16 根影响时拒绝。仍可显式 `clear` 清除变形。该插值不保证任意拓扑变化无损，改动设置位置会改变运动。局部重心细分也会插值保留变形。
- 动画精简的误差限作用于 FPS 网格、中点和原关键帧采样，不是连续时间上的数学证明。选择性烘焙保留约束和其他动画，仅在新动画中关闭所选约束的混合；交互导致核对失败时需选择完整约束组。
- 普通物理预览从时间零重置后按固定步长模拟；`spine_check_physics_cycles` 专门验证保留物理历史的多轮采样误差。
- 本机 4.3.23 的 JSON 和二进制导入某些凹裁剪附件时会改变凸包标记，包括官方 Spineboy 的一个裁剪附件，兼容问题尚未修复。可用 `spine_check_native_compatibility` 提前检查，预检也返回诊断。核对同时考虑设置形状、权重和变形时间轴；动画中可能变凹的附件不能按设置凸形放行。原 `.spine` 保留，JSON 编辑与预览仍可用。完整支持矩阵见 `SUPPORT.json`。

`npm run smoke:production` 通过已注册 MCP 逐个调用全部 29 个新工具，验证原生工程、带孔洞和岛屿的复合网格、图集解包、交付目录搬移、检查点复用、断开客户端后的执行与失败重试。报告在 `work/production-report.json`。

`npm run smoke:official` 使用 `work/official-examples` 中官方 Spine Runtimes **4.2 分支**的 Raptor、Mix-and-match、Stretchyman、Cloud-pot 四个工程，由本机 4.3.23 转换和回导，覆盖复杂约束/变形、多皮肤及物理。Stretchyman 归为路径/变换场景；Cloud-pot 确实包含 26 个物理约束，物理验收同时断言存在此类约束。这些是官方代表性样例，并非用户的生产工程。报告在 `work/official-regression-report.json`。官方样例来源与使用条款保留在其 Git 仓库中，不包含在发布包内。

`npm run smoke:advanced-official` 进一步在上述四个工程各选一个动画/皮肤，运行新版完整约束烘焙，再生成原生工程并核对采样几何；Cloud-pot 启用固定步长物理模拟。报告为 `work/advanced-official-report-2.1.1.json`。4.3 变换约束只为实际映射的输出属性生成零混合关键帧，恒定变形的线性/阶梯改写按等价行为核对；发生变化的插值仍拒绝。

## 检查点工作流

参见 `examples/production-pipeline.json`，按步骤 ID 建立依赖。`inputFrom` 使用前一步的文件输出，步骤自动选择新的输出位置。复用要求请求、源数据、资源和结果文件哈希一致；中间结果被修改或丢失时重新执行。相同流水线 ID 同时只能运行一次，进程异常退出后可恢复。固定 `output` 已存在时仍拒绝覆盖。

`spine_start_job` 支持 `operation=pipeline`、`operation=deliver` 与 `operation=export_media`，允许客户端断开。失败/取消任务可用 `spine_retry_job` 新建重试；工程任务可传 `newOutput` 避免与已生成文件冲突。长任务取消在阶段边界检查。

## 安装、迁移与搬移

现有配置仍兼容。迁移到一个新配置文件：

```powershell
npm run setup -- --config spine.local.json --output spine.updated.json
```

新环境可增加 `--workspace D:/animations --cli C:/Spine/Spine.com`。脚本验证固定的 4.3.23 配置并输出 MCP 启动参数，保留旧配置。通过 `SPINE_MCP_CONFIG` 选择新配置。

`npm run release` 创建包含编译产物、源代码、锁定依赖、说明与文件哈希的独立发布目录，不包含工作资源、安装包、运行库授权或用户配置。目录可复制到其他本地路径，运行 `Install.ps1` 安装依赖，再用 `setup` 指定该机器现有的 Spine CLI。目标机器需要 Node.js 22.2+ 及自己的可用 Spine 安装。

`npm run smoke:productization` 验证配置迁移、发布目录复制到含空格的新路径、干净依赖安装及原生 CLI 连接。`npm run benchmark` 输出本机信息性性能报告，样例为 200 骨骼、10 动画、59,700 个关键帧；不将机器速度作为单元测试断言。

## 本机运行

需要 Node.js 22.2+。已安装依赖并生成 `dist/`：

```powershell
cd C:\path\to\spine-mcp
npm run doctor
npm test
npm run smoke
npm run smoke:workflow
npm run smoke:artwork
npm run smoke:animation
npm run smoke:features
npm run smoke:rigging
npm run smoke:weights
npm run smoke:alpha
npm run smoke:reuse
npm run smoke:mesh
npm run smoke:timelines
npm run verify:registered
```

`npm start` 启动 MCP stdio 服务，由客户端管理其生命周期；单独启动后会等待 stdin 请求。常规日志写入 stderr，stdout 仅用于 MCP 消息。

`npm run smoke` 通过真正的 MCP 客户端创建隔离测试资源并执行导入、导出、打包和路径检查，结果保存在 `work/smoke-report.json`，同时返回测试工程和预览图的绝对路径。

`npm run smoke:workflow` 使用上一次基础验收的 `.spine` 副本作为输入，通过已注册的 `spine43` 验证批量修改、原始文件 SHA-256 不变、导出核对和预览。验收报告为 `work/workflow-report.json`。

`npm run smoke:artwork` 通过已注册的服务验证全部新增工具，生成两个皮肤、换图与淡入淡出动画、缩放贴图，完成本机 4.3.23 的工程导入与重新导出核对。报告为 `work/artwork-report.json`，其中包含工程和贴图预览的绝对路径，并记录源 JSON 与 PNG 的哈希。单元检查还验证实际渲染像素的图片方向和颜色相乘结果。

`npm run smoke:animation` 独立生成测试数据，通过已注册服务验证六个动画工具、同刻多事件与中文参数、Bezier 减速、时间偏移、绘制顺序切换及时间轴删除，再由本机 4.3.23 生成工程并重新导出核对。报告为 `work/animation-report.json`。自动检查覆盖时间调整前后的运行时姿态与透明度、全部四槽位排列、有效事件参数、附件复用、细分前后的动画表面、选择性通道复制和 Bezier 局部调时以及核对失败时禁止发布等行为；准确数量记录在当次发布验收报告。

`npm run smoke:features` 验证重命名/删除/换父骨骼、五类约束与关键帧、加权/链接网格、变形、裁剪、图片序列、混合、裁剪/镜像/拼接/烘焙，再构建和修改多骨架工程。最后提交连续帧任务并关闭 MCP 连接，重新连接后确认后台任务仍成功完成。报告为 `work/features-report.json`，包括生成工程、预览和离线播放器路径。

`npm run smoke:rigging` 专门验证规则网格生成、按骨骼距离自动绑定、分组绘制顺序和等价展开，以及此前的 Slider 引用错位修复。包含未排序/纯数字/中文文件夹动画名、多个 Slider、二进制导出、多骨架重建和断开 MCP 后的后台工程编辑。报告为 `work/rigging-report.json`。

`npm run smoke:weights` 通过已注册的服务验证权重分页检查、清理和平滑，五种类型使用相同中文约束名，按类型选择时间轴和皮肤成员，定向重命名/删除，以及未排序的权重与稀疏/链接变形导入。包括 `.spine` 回导核对、二进制 Slider 引用、多骨架和断开连接后完成权重任务，报告为 `work/weights-report.json`。

`npm run smoke:alpha` 验证 PNG 凸包分析、顶点数受限时的保守包围、多皮肤网格、跨骨骼碰撞框、镜像裁剪范围及自动权重。随后执行本机工程/二进制导出、多骨架、断开 MCP 后的后台生成，报告为 `work/alpha-report.json`。

`npm run smoke:reuse` 验证跨槽位/皮肤复制、镜像错切坐标转换、稀疏变形、图片序列、共享链接及独立时间轴、解除链接后保留有效动画。随后执行本机工程回导、二进制链接检查、多骨架，以及断开 MCP 后完成包含三种新编辑的后台任务，报告为 `work/reuse-report.json`。

`npm run smoke:mesh` 验证网格/三角形分页、选定顶点变换、加权与非加权网格细分，逐时刻采样原顶点、新中点及三角形内部，核对源网格、继承/独立链接和跨皮肤链接的表面及图片序列。随后执行本机工程回导、二进制拓扑/边索引检查、多骨架构建与修改，以及断开 MCP 后完成网格编辑，报告为 `work/mesh-report.json`。

`npm run smoke:timelines` 验证时间轴分页、骨骼/槽位/五类同名约束/全局物理/附件/事件/绘制顺序通道复制、不同权重排列的变形重排、继承链接的有效来源和相邻 Bezier 区间的局部调时。随后执行本机工程回导、二进制 Slider 引用、多骨架构建与修改及断开 MCP 后的后台任务，报告为 `work/timelines-report.json`。

## 配置

配置文件：`spine.local.json`。默认工作目录为本项目下的 `work/`，所有输入和输出都限制在这个目录中。要处理自己的资源，可将 `workspaceRoot` 设为相应的本地动画项目目录，再重载 MCP；也可把测试所需资源放到 `work/`。

环境变量可以覆盖配置：

- `SPINE_MCP_CONFIG`：配置文件绝对路径。
- `SPINE_MCP_ROOT`：动画工作目录。
- `SPINE_MCP_EXE`：已验证的 CLI 可执行文件或现有启动脚本。

本机安装包通过临时目录运行。适配器根据 `cliRuntimeDiscovery` 查找安装包**已有**的 `Run-Spine.bat`，不固定进程号或某一个临时目录，不复制应用文件，也不改写启动器。每次调用启动独立后台进程，输入来自已保存文件，输出写到新文件；主编辑器不需要取得焦点。

若重启后运行目录已被安装包清理，先正常启动一次现有 Spine，让运行目录生成，之后 MCP 即可在后台调用。标准安装可直接将 `cliExecutable` 设为 `Spine.com`，并删除 `cliRuntimeDiscovery`。本机临时目录发现仅适用于当前这类安装包。

批处理入口会拒绝引号、换行以及 `& | < > ^ % !` 等 CMD 特殊字符，中文和空格路径已纳入集成测试。原生 `.exe`/`.com` 入口直接使用参数数组。

## 接入 Codex

在仓库根目录执行：

```powershell
$spineMcpDirectory = (Get-Location).Path
codex mcp add spine43 --env "SPINE_MCP_CONFIG=$spineMcpDirectory/spine.local.json" -- node "$spineMcpDirectory/dist/src/index.js"
codex mcp get spine43 --json
```

也提供了 `codex-mcp.example.toml` 配置片段。其它 MCP 客户端可参考 `mcp.example.json`，将示例路径替换为实际克隆目录后使用。重新连接 MCP 后核对服务版本与工具数量。配置方式参考 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 当前对话的后台调用入口

无需操作桌面应用。这个客户端读取已注册的 `spine43` 配置，启动标准 stdio MCP 连接，调用后自动关闭连接：

```powershell
cd C:\path\to\spine-mcp
npm run call -- list
npm run call -- spine_status --args-file examples/status.json
```

调用其它工具时，把参数存入 JSON 文件后通过 `--args-file` 传递，避免命令行中的 JSON 引号和转义问题。图片结果只输出路径、类型和大小，预览文件仍保存在工作目录，客户端不会把 Base64 图片数据打印到终端。

`--local` 可显式使用当前目录中的服务代码，适合开发测试；默认使用已注册服务，不会静默切换。文件处理无需编辑器焦点；显式打开编辑器可能激活窗口。

## 工具

| 工具 | 功能 | 需要 Spine CLI |
|---|---|---|
| `spine_status` | 工作目录、版本、能力和入口检测 | 显式探测时使用 |
| `spine_create_project` | 创建并核对 root 骨骼工程，可选自动打开 | 是 |
| `spine_open_project` | 用独立进程打开保存的 `.spine`，默认新实例 | 否，需编辑器入口 |
| `spine_get_editor_open_status` | 重连后查询打开请求和窗口证据 | 否 |
| `spine_inspect` | 骨骼、插槽、皮肤、约束和动画摘要 | 输入为 `.spine` 时 |
| `spine_validate` | 结构、引用和关键帧时间检查 | 输入为 `.spine` 时 |
| `spine_get_animation` | 读取指定动画的完整时间轴 | 输入为 `.spine` 时 |
| `spine_set_bone` | 修改设置姿态中的骨骼变换 | 输入为 `.spine` 时 |
| `spine_add_bone` | 添加子骨骼 | 输入为 `.spine` 时 |
| `spine_add_animation` | 新建或复制动画 | 输入为 `.spine` 时 |
| `spine_set_timeline` | 替换旋转、位移、缩放或错切时间轴 | 输入为 `.spine` 时 |
| `spine_apply_edits` | 将有序批量操作写入一个新 JSON | 输入为 `.spine` 时 |
| `spine_add_slot` | 在设置绘制顺序末尾添加槽位 | 输入为 `.spine` 时 |
| `spine_set_slot` | 修改槽位的骨骼、附件、颜色、混合和可见性 | 输入为 `.spine` 时 |
| `spine_add_skin` | 创建或复制皮肤，处理附件内部名称与图片路径 | 输入为 `.spine` 时 |
| `spine_attach_image` | 读取 PNG 尺寸，添加或更新静态图片附件 | 输入为 `.spine` 时 |
| `spine_set_attachment_timeline` | 换图及隐藏关键帧 | 输入为 `.spine` 时 |
| `spine_set_color_timeline` | 槽位 RGBA 变色和淡入淡出关键帧 | 输入为 `.spine` 时 |
| `spine_set_event` | 创建或更新事件的整型、浮点和字符串默认参数 | 输入为 `.spine` 时 |
| `spine_set_event_timeline` | 设置事件关键帧，支持同一时刻触发不同事件 | 输入为 `.spine` 时 |
| `spine_set_draw_order` | 通过完整槽位列表设置绘制顺序关键帧 | 输入为 `.spine` 时 |
| `spine_inspect_timelines` | 分页读取通道、关键帧范围、曲线统计和链接继承来源 | 输入为 `.spine` 时 |
| `spine_copy_timelines` | 在同一骨架内按对象映射复制通道，支持时间缩放和变形影响重排 | 输入为 `.spine` 时 |
| `spine_retime_keyframes` | 仅调整指定通道和时间范围内的关键帧，重算相邻 Bezier 时间控制点 | 输入为 `.spine` 时 |
| `spine_retime_animation` | 调整动画时间比例与偏移，同步 Bezier 时间坐标 | 输入为 `.spine` 时 |
| `spine_rename_animation` | 重命名动画并更新 Slider 的动画引用 | 输入为 `.spine` 时 |
| `spine_remove_timeline` | 删除一条骨骼/槽位通道或事件/绘制顺序时间轴 | 输入为 `.spine` 时 |
| `spine_edit_project` | 批量编辑单骨架工程，重新导出核对，成功后另存 `.spine` | 是 |
| `spine_check_loop` | 对比骨骼、槽位和绘制顺序的首尾关键值 | 输入为 `.spine` 时 |
| `spine_create_demo` | 创建隔离测试骨架和图片 | 否 |
| `spine_render_preview` | 后台生成骨骼姿态 PNG，可同时比较多个时刻 | 输入为 `.spine` 时 |
| `spine_render_artwork` | 后台生成带 PNG 贴图的预览，包含换图和透明度动画 | 输入为 `.spine` 时 |
| `spine_editor_handoff` | 返回文件及可选的手动查看步骤 | 否 |
| `spine_project_info` | 读取保存工程的信息 | 是 |
| `spine_export` | 导出 JSON 或 `.skel` | 是 |
| `spine_import` | 将 JSON 导入为新的 `.spine` 工程 | 是 |
| `spine_pack_atlas` | 图集打包 | 是 |
| `spine_rename_object` | 重命名骨骼、槽位、皮肤、约束、动画或附件并更新已知引用 | 输入为 `.spine` 时 |
| `spine_delete_object` | 删除对象；依赖存在时要求显式级联 | 输入为 `.spine` 时 |
| `spine_reparent_bone` | 改变父骨骼、重排索引；可保留无约束设置姿态的世界变换 | 输入为 `.spine` 时 |
| `spine_set_slot_order` | 修改设置绘制顺序，保持已有全局绘制顺序关键帧对应的排列 | 输入为 `.spine` 时 |
| `spine_set_constraint` | 设置 IK、变换、路径、物理或 Slider 约束及执行顺序 | 输入为 `.spine` 时 |
| `spine_set_constraint_timeline` | 设置五类约束的参数、曲线或重置关键帧 | 输入为 `.spine` 时 |
| `spine_set_skin_members` | 设置皮肤的骨骼和约束成员 | 输入为 `.spine` 时 |
| `spine_set_attachment` | 设置网格、链接网格、路径、裁剪等 4.3 附件 | 输入为 `.spine` 时 |
| `spine_copy_attachment` | 跨皮肤/槽位独立复制附件，可保留设置姿态世界几何与有效时间轴 | 输入为 `.spine` 时 |
| `spine_link_mesh` | 创建共享网格，选择继承时间轴或复制为独立时间轴 | 输入为 `.spine` 时 |
| `spine_unlink_mesh` | 将链接网格独立化，默认保留实际生效的变形与序列动画 | 输入为 `.spine` 时 |
| `spine_inspect_mesh` | 分页查看 UV、设置姿态顶点、三角形、拓扑问题和共享链接 | 输入为 `.spine` 时 |
| `spine_transform_mesh` | 平移/旋转/缩放指定顶点，同步变形向量和相关链接 | 输入为 `.spine` 时 |
| `spine_refine_mesh` | 四分三角形，插值 UV/权重并保留源和链接的变形动画 | 输入为 `.spine` 时 |
| `spine_mesh_from_region` | 将静态区域附件转为规则网格，保留图片与设置姿态 | 输入为 `.spine` 时 |
| `spine_trace_region` | 读取静态 PNG 的透明度凸包、UV 和设置姿态边界 | 输入为 `.spine` 时 |
| `spine_mesh_from_alpha` | 按 PNG 透明度凸包生成带中心点的网格 | 输入为 `.spine` 时 |
| `spine_polygon_from_region` | 从 PNG 凸包生成碰撞框或裁剪附件，转换到目标骨骼坐标 | 输入为 `.spine` 时 |
| `spine_auto_weights` | 按顶点到指定骨骼线段的距离自动绑定初始权重 | 输入为 `.spine` 时 |
| `spine_inspect_weights` | 分页读取权重、绑定坐标、骨骼统计和链接来源 | 输入为 `.spine` 时 |
| `spine_clean_weights` | 清理小权重、限制影响骨骼数并归一化 | 输入为 `.spine` 时 |
| `spine_smooth_weights` | 沿三角形邻接关系平滑选定顶点的权重 | 输入为 `.spine` 时 |
| `spine_set_folder_draw_order` | 设置互不重叠的分组绘制顺序关键帧 | 输入为 `.spine` 时 |
| `spine_flatten_draw_order` | 把分组时间轴转换为等价的全局绘制顺序 | 输入为 `.spine` 时 |
| `spine_set_weights` | 按骨骼名称绑定权重，可自动保留设置姿态的世界顶点 | 输入为 `.spine` 时 |
| `spine_set_attachment_animation` | 设置稀疏变形或图片序列关键帧 | 输入为 `.spine` 时 |
| `spine_crop_animation` | 按帧率采样裁剪动画，保留范围内事件和离散切换 | 输入为 `.spine` 时 |
| `spine_merge_animations` | 拼接相同时间轴集合的动画，可设置间隔 | 输入为 `.spine` 时 |
| `spine_mirror_animation` | 镜像选定骨骼的局部动作偏移和曲线 | 输入为 `.spine` 时 |
| `spine_bake_animation` | 生成移除约束、仅保留所选动画的独立骨骼烘焙副本 | 输入为 `.spine` 时 |
| `spine_export_frames` | 连续 PNG 帧、固定视口、JSON 清单和本地 HTML 播放器 | 输入为 `.spine` 时 |
| `spine_build_project` | 合并并核对多个 JSON 骨架，生成新工程 | 是 |
| `spine_edit_multi_project` | 修改指定骨架，重建并核对全部骨架 | 是 |
| `spine_batch` | 批量检查、校验或导出，每个文件分别返回结果 | 处理 `.spine` 或导出时 |
| `spine_start_job` | 提交独立后台进程执行的持久任务 | 取决于任务 |
| `spine_get_job` | 读取任务状态、阶段进度和可选结果 | 否 |
| `spine_list_jobs` | 列出最近任务 | 否 |
| `spine_cancel_job` | 请求在阶段间协作取消，不终止编辑器 | 否 |
| `spine_resume_jobs` | 恢复停下的队列；中断过的运行任务标记失败，避免重复执行 | 否 |

`spine_editor_handoff` 仅提供可选的查看说明，自动处理流程不需要它。

## 示例工作流

对已保存的单骨架工程，优先使用 `spine_edit_project`。它与 `spine_apply_edits` 共享有序编辑操作，包含基础骨骼/槽位/皮肤/事件编辑，以及 `rename`、`delete`、`reparent_bone`、`set_slot_order`、`copy_timelines`、`retime_keyframes`、`set_constraint`、`set_constraint_timeline`、`set_skin_members`、`set_attachment`、`copy_attachment`、`link_mesh`、`unlink_mesh`、`transform_mesh`、`refine_mesh`、`mesh_from_region`、`mesh_from_alpha`、`polygon_from_region`、`auto_weights`、`clean_weights`、`smooth_weights`、`set_folder_draw_order`、`flatten_draw_order`、`set_weights`、`set_attachment_animation`、`crop_animation`、`merge_animations`、`mirror_animation`、`bake_animation`。按传入顺序执行，每批 1–100 项；任一项失败时不写出结果。文件 `examples/edit-project.json` 提供参数模板，使用前将输入、输出及骨骼名称替换为实际工程中的名称：

```powershell
npm run call -- spine_edit_project --args-file examples/edit-project.json
```

工作流核对骨骼层级及设置姿态、槽位/皮肤/附件/事件/约束/动画名称、槽位设置绘制顺序与状态、皮肤成员关系、静态图片附件的尺寸/路径/变换/颜色、支持的骨骼和槽位关键帧与曲线、时间轴通道集合、事件默认参数及关键帧实际参数、全局绘制顺序关键帧对应的槽位排列、Slider 动画引用，以及图片和音频路径。核对失败或源文件在执行过程中发生变化时，不发布最终输出。返回的 `reportPath` 为本次验收报告。`spine_edit_project` 保持单骨架入口；多骨架工程用 `spine_edit_multi_project`，它会核对未修改骨架，避免遗漏。验证现在也覆盖约束定义/执行顺序/参数曲线、网格 UV/三角形/权重/链接来源、变形和序列关键帧、文件夹绘制顺序。JSON 流程仍不能保证保留编辑器内部信息。

需要分步处理时：

1. `spine_status` 检测环境。
2. `spine_inspect` 读取保存的 `.spine` 工程，取得 `workingJson`。
3. `spine_set_timeline` 修改工作 JSON，`output` 指向一个新文件。
4. `spine_render_preview` 查看骨骼姿态，或用 `spine_validate` 检查结构。
5. `spine_import` 把修改后的 JSON 转为新的 `.spine`；用 `spine_export` 导出游戏资源。

旋转关键帧示例（时间单位为秒，角度是相对设置姿态的偏移）：

```json
{
  "input": "hero.json",
  "output": "edits/hero-wave.json",
  "animation": "wave",
  "bone": "arm",
  "channel": "rotate",
  "keyframes": [
    { "time": 0, "value": 0 },
    { "time": 0.5, "value": 35 },
    { "time": 1, "value": 0 }
  ]
}
```

位移、缩放和错切使用 `x`、`y`；省略 `curve` 为线性，`"stepped"` 为阶梯插值。数值 Bezier 数组按 4.3 JSON 使用 4 个（单通道）或 8 个（双通道）控制值。

## 贴图、换肤和淡入淡出

`examples/artwork-project.json` 提供一份批量贴图动画模板，`examples/artwork-preview.json` 提供预览参数。先按实际资源修改路径、槽位和动画名称，再运行：

```powershell
npm run call -- spine_edit_project --args-file examples/artwork-project.json
npm run call -- spine_render_artwork --args-file examples/artwork-preview.json
```

单个 `spine_attach_image` 或批量 `attach_image` 的 `image` 参数是工作目录内的绝对路径或相对路径；该 PNG 还必须位于当前 JSON 的 `skeleton.images` 目录内。图片按引用使用，不复制也不修改原始图片。`transform.width`/`height` 表示期望显示尺寸；服务会将其折算为 `scaleX`/`scaleY`，再乘以显式提供的缩放，确保编辑器导入时恢复 PNG 像素尺寸后仍显示为预期大小。`replace` 默认关闭，仅在显式开启时更新新输出中的既有静态附件。

普通命名皮肤可以直接复制；复制品拥有独立附件、原占位符名称和图片路径，并分配唯一的附件内部名称。`default` 存放的是编辑器中未放入皮肤占位符的公共附件。若要把它作为换肤的基础，必须同时传入 `copyFrom: "default"` 和 `baseSkin: "base"`：新输出先将原默认附件移入名为 `base` 的皮肤，再创建复制品；预览时显式选择 `skin: "base"` 或复制品名称。这个转换只发生在新输出。此行为参考 [官方皮肤说明](https://en.esotericsoftware.com/spine-runtime-skins)，并经过本机 4.3.23 导入验证。

换图关键帧使用附件**占位符**名称，`name: null` 隐藏槽位。RGBA 时间轴使用不带 `#` 的 `RRGGBB` 或 `RRGGBBAA`，例如 `ffffff00` 完全透明，`ffffffff` 完全不透明。时间以秒为单位，默认线性插值；也支持 `stepped` 与四个颜色分量共 16 个数值的 Bezier 控制值。已经存在 RGB、Alpha 或双色时间轴时，新增 RGBA 时间轴会明确报冲突。

`spine_render_artwork` 支持一至八个采样时刻，使用真实 PNG、骨骼世界变换、绘制顺序、槽位换图和颜色/透明度生成预览，并返回各槽位的图片、占位符、内部名称、世界顶点和颜色值。支持区域、网格、加权网格、链接网格、变形、普通/反向裁剪、图片序列、双色着色及 normal/additive/multiply/screen 混合。`physics: true` 可从零时刻重置后按 `fps` 固定步长模拟；默认关闭。CPU 边缘抗锯齿可能与游戏 GPU 渲染不同。单张 PNG 限制为 16 MiB、8192 像素边长及 16 兆像素；一次预览最多加载 128 张图片、64 MiB 文件数据及 64 兆像素。

## 动画时间、事件和绘制顺序

`examples/animation-project.json` 演示在一个新动画副本中设置事件、调整绘制顺序、减速并重命名。按自己的工程替换输入输出、原动画名及完整槽位列表后调用：

```powershell
npm run call -- spine_edit_project --args-file examples/animation-project.json
npm run call -- spine_render_artwork --args-file examples/animation-preview.json
```

`set_event` 创建或更新事件定义的 `defaults`，包含 `int`、`float`、`string`；`set_event_timeline` 的每个关键帧包含 `time`、`name` 和可选参数，省略的参数继承定义中的默认值。先定义事件，再添加引用它的关键帧。时间非递减，允许同刻多事件；编辑器决定同刻事件的输出顺序，核对时比较同刻事件的数量和实际参数，不要求其排列相同。整型限制为 32 位有符号整数，浮点参数必须能表示为有限单精度数。工具仅编辑数据，不执行游戏回调或播放音频。

`set_draw_order` 接受 `keyframes: [{ "time": 0.5, "order": ["back-slot", "front-slot"] }]`。每个列表必须包含骨架的全部槽位且每项一次，按从后到前的绘制顺序排列。`order: null` 恢复设置顺序。服务自动编码 4.3 的全局 `drawOrder` 偏移，核对实际槽位排列，因此编辑器改写等价偏移不会误报。已有绘制顺序文件夹时间轴时，该编辑工具会报不支持。

`retime_animation` 使用 `新时间 = 原时间 × timeScale + timeOffset`。例如 `timeScale: 2`、`timeOffset: 0` 将动画放慢一倍；`timeScale: 0.5` 将其加快一倍。骨骼与 RGBA 的数值保持不变，Bezier 数组中横向时间控制值同步变换，纵向数值控制值保留。正时间偏移使首帧延后，本服务的预览在延后区间显示设置姿态。支持全部已知 4.3 骨骼/槽位通道、五类约束、变形、序列、事件及全局/文件夹绘制顺序；序列 `delay` 也随时间比例缩放。遇到未知非空时间轴会明确拒绝。缩放必须为正，关键帧移至负时间、超出单精度范围或精度下降导致原本不同的时间合并时会报错。

`rename_animation` 接受 `animation` 与未使用的 `newName`，同时更新 4.3 Slider 约束中的已知动画引用。它保留其它任意字符串字段。`remove_timeline` 接受明确的 `target`，例如 `{ "kind": "slot", "slot": "arm-slot", "channel": "alpha" }`、`{ "kind": "bone", "bone": "arm", "channel": "rotate" }`、`{ "kind": "events" }` 或 `{ "kind": "drawOrder" }`。仅删除指定时间轴，事件定义仍保留；目标不存在时会报错。可先移除 Alpha/RGB 冲突通道，再添加 RGBA 时间轴。

以上六种操作都能单独写入新 JSON，也能放入 `spine_apply_edits` 或 `spine_edit_project` 的有序批次。事件、绘制顺序的数据语义参考 [官方 JSON 格式](https://en.esotericsoftware.com/spine-json-format)；字段大小写、曲线与偏移行为以所安装的 4.3 运行时及本机 4.3.23 验证为准。`spine_check_loop` 新增槽位附件、RGBA 和绘制顺序首尾差异，仍是首尾关键值比较，不判断首帧前的状态、物理连续性或事件逻辑。

## 结构、约束和网格

结构重命名会更新父子关系、槽位骨骼、约束、皮肤成员、时间轴、裁剪结束槽位及链接网格等已知引用。附件重命名按槽位占位符处理，保留实际图片路径。删除有依赖的对象需要 `cascade: true`；仍被其它附件引用的链接来源或权重骨骼会明确拒绝删除。换父骨骼的 `preserveWorld` 只针对设置姿态：含约束的工程使用 `false` 保留局部数值；动画世界运动不会自动烘焙。

`set_constraint` 的 `definition` 使用 4.3 字段。变换约束使用 `source` 和 `properties: { x: { to: { x: {} } } }`，路径约束使用 `slot`，物理约束使用 `bone`，Slider 使用 `animation`。IK/变换的关键帧通道为 `parameters`；路径为 `position/spacing/mix`；物理为 `inertia/strength/damping/mass/wind/gravity/mix/reset`；Slider 为 `time/mix`。空约束名 `""` 表示全局物理时间轴。约束按“类型＋名称”识别，五种类型可以共用名称，同类型内仍要求唯一。`set_constraint_timeline` 和重命名/删除的 `target` 在重名时必须给出 `constraintType`；不重名时兼容原来的名称参数。`set_skin_members.constraints` 接受唯一名称字符串或 `{ "name": "控制", "type": "ik" }`，歧义名称会在写文件前拒绝。更新定义按 `definition.type/name` 匹配，不会覆盖其他同名类型。参考 `examples/typed-constraints.json`。

已修复本机 4.3.23 的 Slider 导入引用错位：输入 JSON 的动画顺序与编辑器排序不同时，导入引用可能错位。导入前先取得编辑器给出的实际动画顺序，再按该顺序序列化原动画内容，保持名称和数据不变；纯数字动画名也保留序列化顺序。导入后重新导出核对每个 Slider 的引用，通过后才发布。单骨架、多骨架及后台工程任务均使用此流程。

`set_attachment` 接受完整的 `attachment` 数据；替换已有记录需 `replace: true`。`set_weights` 每个顶点使用一个影响数组，例如 `[{ bone: "arm", weight: 0.8 }, { bone: "control", weight: 0.2 }]`，自动归一化；省略绑定 `x/y` 时从原设置姿态推导。权重布局改变会使旧变形数据失效，因此已有变形时必须显式选择 `clearDeform: true`。规则网格、PNG 凸包生成和距离权重见后续章节；尚无凹形/孔洞多边形自动描边或权重画笔。

`set_attachment_animation` 的 `channel` 为 `deform` 或 `sequence`。变形关键帧使用 `offset/vertices`；序列使用 `mode/index/delay`，图片名称由附件 `sequence.count/start/digits/setup` 与 `path` 组合。参考 `examples/geometry-project.json`。

## 附件复制与链接网格独立化

`spine_copy_attachment` 用 `from/to: { skin, slot, name }` 指定来源和新目标，目标皮肤与槽位必须存在，同名目标不会覆盖。区域、独立/链接网格、路径、碰撞框、裁剪和点附件均可复制；链接来源会展开为独立几何。保留图片路径、颜色和序列定义，生成独立的内部名称，不复制图片文件。默认 `setAsSetup: false`，需要直接显示时显式设为 `true`。

默认 `preserveWorld: true`，按源/目标皮肤的设置姿态转换绑定坐标，并同步转换变形偏移。跨骨骼区域复制遇到坐标变化时会转成四顶点网格，以保持旋转、非均匀缩放、错切或镜像后的角点；图片序列仍保留。加权附件逐影响骨骼转换，要求相关骨骼在两种皮肤中均激活。目标骨骼变换退化、皮肤/约束导致无法保持几何，或非恒速路径需要转换缓存长度时会拒绝；`preserveWorld: false` 则保留原局部数据。**设置姿态匹配不会把源骨骼的动画世界运动烘焙到目标骨骼上。** 槽位颜色、混合和换图时间轴也不随附件复制。

默认 `copyTimelines: true`，复制实际生效的附件 `deform/sequence` 时间轴及曲线。继承时间轴的链接按其源网格读取，而非复制链接上被忽略的同名轨道。静态目标不生成序列关键帧；带序列的目标须与有效来源帧数一致，否则明确报错，可显式关闭时间轴复制。参考 `examples/copy-attachment.json`。

`spine_link_mesh` 也使用 `from/to`，来源须为独立网格，避免创建链接链。默认 `inheritTimelines: true`，共享来源几何及变形/序列时间轴；设为 `false` 后可用 `copyTimelines: true` 复制为独立时间轴，之后按目标附件单独编辑。默认 `preserveWorld: false`，共享局部几何；显式开启时只在源/目标设置姿态世界顶点一致时通过。不能通过移动共享顶点来补偿另一槽位的位置，需要此行为时使用独立复制。

`spine_unlink_mesh` 接受 `skin/slot/name`，将选定链接替换为独立网格，其他链接保留。默认 `preserveTimelines: true`：继承的有效时间轴写入目标，原来已独立的时间轴保留；`false` 仅清除所选附件的变形/序列通道。图片路径、颜色及序列定义来自所选链接自身。三项操作均可用于有序批次、工程、多骨架和持久后台任务。`examples/reuse-project.json` 演示在演示骨架上创建目标骨骼/槽位、复制、链接及独立化；使用前替换路径和对象名。

## 网格检查、选定顶点变换与细分

`spine_inspect_mesh` 接受 `skin/slot/name`，返回源网格、共享链接、顶点/三角形/边界数量、相关变形通道数量，以及可分页的 UV、影响骨骼数、设置姿态的槽位局部/世界坐标和三角形索引。`offset/limit` 控制顶点页，`triangleOffset/triangleLimit` 控制三角形页，默认每页 100、最多 500。未激活骨骼的几何标记为不可用，仍可读取 UV 和拓扑；加权网格所在槽位骨骼退化时局部坐标为 null。共享链接最多列出前 100 个，附总数和截断标记。

检查会统计重复顶点的三角形、重复三角形、退化 UV 三角形、未使用顶点、非流形边、相邻面朝向冲突、无效手工边，以及 hull 是否完整；每类问题返回数量及前 20 项。`refinable` 表示满足本工具的细分条件。**不检测三角形相交，也不保证视觉效果正确。** 参考 `examples/mesh-inspect.json`。

`spine_transform_mesh` 只编辑独立源网格；用 `vertices: [2, 3]` 选择顶点，省略时处理全部顶点。索引来自检查结果，必须有效且不重复。`transform` 的 `x/y` 是平移，`rotation` 为角度，`scaleX/scaleY` 默认 1，`pivotX/pivotY` 默认 0；先绕支点缩放、旋转，再平移，坐标均为**源槽位骨骼的设置姿态局部坐标**。UV、三角形和权重值保持不变。加权顶点通过设置姿态骨骼矩阵转换绑定坐标，要求相关骨骼激活且矩阵可逆。后续运动仍使用已有绑定，不把动画世界轨迹烘焙成新的轨迹。

默认 `transformDeform: true`，对选中顶点对应的变形偏移应用线性部分，平移不加到偏移上；同时处理源网格及使用同一几何的独立链接变形，保留时间与曲线。`false` 明确保留原变形数值。共享源的几何变化会影响全部链接；需要独立修改某个链接时先执行 `unlink_mesh`。

`spine_refine_mesh` 对每条边插入共享中点，每个三角形细分为四个，`iterations` 为 1–3、默认 1。插值 UV 和绑定坐标；加权中点合并两端的影响骨骼，以权重求绑定坐标及逐影响变形的平均，保留原来的动画分片线性表面。源网格、继承链接和独立链接的变形均同步映射，时间、曲线、图片序列、路径和颜色保留。细分增加可编辑顶点，不会自动生成更平滑的轮廓或新动作。

细分要求单一完整 hull、连续一致且 UV 不退化的三角形拓扑、有效手工边，无未使用顶点。生成 hull 在前的顶点及明确的三角形边；手工边集合随细分重建。**顶点索引会变化**，继续选点前应重新检查。若新增中点需要超过 16 根骨骼影响，直接拒绝，不裁剪影响或权重；可先清理原权重。限制为 10,000 顶点、200,000 三角形，每次操作最多处理 5,000,000 个变形坐标，超限不发布结果。核对仍会提示编辑器对三角形列表的重排及自重叠覆盖顺序限制。

三项工具沿用后台文件处理流程；两项编辑已接入工程、多骨架和队列。示例 `examples/mesh-project.json` 在演示骨架上创建网格、自动绑定、设置变形、编辑顶点并细分；`examples/background-mesh.json` 提交已有网格的后台任务。输入名称和顶点索引需换成实际数据，输出必须为新文件。

## 权重检查、清理和平滑

`spine_inspect_weights` 返回顶点数量、最大/总影响数、权重和范围、各骨骼统计及分页顶点。每项含骨骼名、权重和局部绑定坐标；默认每页 100 个顶点，`offset` 从零开始，`limit` 为 1–500，返回下一页偏移。链接网格同时给出实际来源；未加权网格显示隐含的槽位骨骼绑定。参考 `examples/weight-inspect.json`。

`clean_weights` 清除低于 `minWeight`（默认 0.001）的影响，再按权重保留至多 `maxInfluences`（1–16，默认 4）根骨骼并归一化。若阈值移除了全部影响，保留最强的一根。`smooth_weights` 根据三角形连接的邻居同时迭代，`strength` 为 0–1（默认 0.5），`iterations` 为 1–20（默认 2），每轮也执行清理和归一化。不同连通区域不交换权重，孤立顶点保留权重。最多 20 万个三角形、500 万次影响访问，超限会给出错误。

两个编辑操作都要求已加权的非链接网格，可用 `vertices: [0, 1, 2]` 限定顶点。通过共同的世界坐标偏移修正绑定坐标，保留设置姿态的世界顶点；未选择顶点保留原权重和坐标。权重变化会改变动画中的运动效果，应使用贴图预览检查。存在源网格或相关链接网格的变形关键帧时，默认拒绝，只有显式 `clearDeform: true` 才在新输出中移除这些变形，其他网格的变形保留。参考 `examples/weights-project.json`。

手工 `set_weights` 会按骨骼索引排列每个顶点的影响。CLI 导入还会为所有加权顶点附件规范化影响顺序，并同步重排源/链接网格的稀疏变形坐标；源 JSON 不变。核对按骨骼名称及对应变形坐标比较，允许等价的骨骼索引和影响顺序变化。

编辑器有时会重排网格的三角形列表。核对要求同一组有向三角形、相同 UV 和顶点，拒绝翻转朝向、丢失/重复三角形或改变连接关系。列表变化会在 `triangleOrderNormalization` 中列出；**不保证自重叠网格的三角形覆盖顺序**，应对这种动画检查生成工程的预览。

## PNG 透明度凸包、碰撞框和裁剪范围

`spine_trace_region` 读取指定 `skin/slot/name` 的静态区域附件与 PNG，不改文件。返回满足阈值的像素数量/比例、像素边界、凸包 UV，以及附件局部和设置姿态世界坐标。支持透明孔洞、多个分离区域及旋转/镜像显示变换；结果是包围它们的**凸包**，不区分孔洞和凹陷。

三个入口共用 `alphaThreshold`（1–255，默认 1）、`padding`（0–64 个源图像素，默认 1）及 `maxVertices`（4–512 个边界顶点，默认 64）。只统计 PNG 自身透明度，不把槽位或附件的显示透明度当成图像轮廓。以像素单元边缘构造凸包；超出顶点预算时，用支撑半平面生成包住原凸包的多边形，避免简单删除边界点而裁掉可见部分。缓冲范围裁在原图边界内。全透明图、序列附件、退化显示变换或越界资源会报错。

`mesh_from_alpha` 原位替换新输出中的静态区域附件，保留名称/图片路径/颜色，把显示平移、旋转和缩放写入顶点；边界顶点在前，追加一个内部中心点并生成扇形三角形。PNG 内容不变，凹陷、孔洞与分离区域继续由图片透明度表现。较高 `alphaThreshold` 可能让低透明度像素处于网格外；这是一种自动初始网格，不等同于精确的凹形网格或密集变形拓扑。

`polygon_from_region` 还需要 `targetSlot/targetName/kind`，`kind` 为 `boundingbox` 或 `clipping`。目标槽位必须存在；生成时把源区域的设置姿态世界边界换算到目标骨骼局部坐标，后续动画跟随目标骨骼。默认 `setAsSetup: true`，此时目标槽位须与源图槽位不同，避免替换图像的设置附件。已有同名附件默认拒绝，可显式 `replace: true`。裁剪可给出 `endSlot`，省略时影响后续槽位；启用设置附件时，要求目标裁剪槽位位于源图之前、结束槽位位于源图或其后，可先用 `set_slot_order` 排序。

碰撞框与裁剪也是凸包，**其几何覆盖孔洞、凹陷和分离区域之间的空白**，需按实际碰撞/遮罩需求调整。若从同一图片同时生成多种附件，先生成多边形，再执行 `mesh_from_alpha`，最后可用 `auto_weights/clean_weights/smooth_weights` 绑定和调整。新操作已接入工程、多骨架和后台任务。示例按演示骨架的一张图片编写，实际工程的 `set_slot_order.order` 必须列出全部槽位。参考 `examples/alpha-trace.json` 与 `examples/alpha-project.json`。

## 几何精度回读

本机 JSON 导出会将部分顶点坐标舍入到两位小数，也会省略接近零的骨骼时间轴数值；数值舍入的背景见 [官方说明](https://esotericsoftware.com/forum/d/16197-rounded-off-value-in-v4017)。含顶点附件或骨骼时间轴的 JSON 导出会额外读取同一输入的二进制导出，补齐浮点顶点、权重、变形，以及旋转/位移/缩放/错切的合并或独立轴数值通道。JSON 曲线保持不变。按骨骼名称和通道匹配，核对版本、附件、顶点/影响布局、帧数量、时间及舍入范围；差异不符合条件时拒绝，避免用另一份数据掩盖不一致。两个导出之间源文件哈希发生变化时，也会拒绝返回混合快照。

`spine_export` 返回 `geometryReadback`，工程验收报告保留 `binaryGeometryReadback`，包含对应二进制文件及附件/变形时间轴数量。此补齐针对几何数据；其他 JSON 元数据、骨骼/约束参数和曲线仍使用编辑器导出的精度。保留非必要字段、关闭动画清理和原文件不覆盖的规则继续适用。

## 规则网格、自动权重和分组绘制顺序

`mesh_from_region` 把已有静态区域附件转换为矩形规则网格；`columns/rows` 表示网格单元数，范围 1–64，默认 2×2。保留占位符、图片路径、颜色和设置姿态，将原局部平移/旋转/缩放写入顶点；生成 UV、边界在前的顶点和三角形。原 PNG 不变。不适用于图片序列，也不按图片透明轮廓描边。

`auto_weights` 需要显式给出候选 `bones`，按设置姿态下顶点到骨骼线段的距离计算初始权重。`influences` 为最多影响数（1–8，默认 4），`power` 为距离衰减指数（1–8，默认 2）；候选最多 256 根骨骼。绑定时推导局部坐标以保留设置姿态的世界顶点，并按骨骼索引排列，兼容本机导入器。已有变形仍需显式 `clearDeform: true`。生成的是几何初始绑定，运动效果可用贴图预览检查和调整。

`set_folder_draw_order` 使用 `folders: [{ slots, keyframes }]`，每组 `slots` 表示成员，自动按设置顺序排列。关键帧的 `order` 必须包含该组全部成员，或为 `null` 表示恢复设置顺序。组之间不能重叠；`folders: []` 清除全部分组时间轴，已有全局关键帧保留。

本机编辑器的 JSON 导入会忽略 `drawOrderFolder`。为保留运行结果，CLI 导入前会将它们编译为全局槽位排列关键帧，覆盖全部变化时刻及首帧前的设置行为；源 JSON 的分组保留，**生成工程中的分组结构会展平**。验证流程比较转换后的排列，并在报告的 `folderDrawOrderNormalization` 中列出受影响的动画。没有忽略丢失数据的核对错误。

也可直接调用 `spine_flatten_draw_order` 或批量编辑 `{ "type": "flatten_draw_order" }`，只生成新的 JSON。空组和空关键帧会在读取时拒绝，删除最后一个分组成员时会移除该时间轴，避免运行时处理空组。

`examples/auto-rig-project.json` 演示网格、自动权重和分组顺序。模板使用演示骨架的 `arm/arm-slot/arm.png`，先把输入输出换成实际路径：

```powershell
npm run call -- spine_edit_project --args-file examples/auto-rig-project.json
```

## 时间轴检查、选择性复制与局部调时

`spine_inspect_timelines` 接受 `input/animation` 和 `offset/limit`，默认每页 100、最多 500 个通道。返回通道总数、关键帧总数、每条通道的选择器 `target`、起止时间、Bezier/阶跃段数量。只列出实际保存且非空的通道，不为继承链接合成轨道；链接上被继承关系忽略的自有轨道会标记 `editable: false`，并给出 `effectiveTarget`。未知通道或顶层格式列在 `unsupported` 中，最多显示前 20 项，不执行其内容。参考 `examples/timeline-inspect.json`。

两个新编辑使用相同的显式选择器：

| kind | 选择字段 |
|---|---|
| `bone` | `bone/channel`，支持旋转、组合/单轴位移/缩放/错切及继承模式 |
| `slot` | `slot/channel`，通道为 attachment、rgba、rgb、alpha、rgba2、rgb2 |
| `constraint` | `constraint/constraintType/channel`，必须明确五类中的类型；全局物理用空约束名和 physics |
| `attachment` | `skin/slot/name/channel`，通道为 deform 或 sequence |
| `events`、`drawOrder` | 无其它字段，分别选择完整事件或全局绘制顺序通道 |

`spine_copy_timelines` 使用 `fromAnimation/toAnimation` 和 `mappings: [{ from, to }]`，一次 1–100 项。来源动画必须存在，目标动画可以新建；两端必须是相同 kind、相同 channel，约束还须相同类型。复制整个选定通道，保留其它通道和数据；目标已有该通道时默认拒绝，只有显式 `replace: true` 才在新输出中替换。一个目标不能重复出现。所有来源读取调用前的同一份快照，支持同动画内交换不同骨骼的通道，不会把前一项复制的结果当作后一项来源。

`timeScale` 默认 1、`timeOffset` 默认 0，复制后时间为 `oldTime * timeScale + timeOffset`，Bezier 的时间控制点同步调整，序列播放 delay 也按比例缩放。骨骼数据是目标设置姿态上的局部偏移，不做世界动作重定向，也不跨骨架读取其它文件。槽位换图关键帧保留原占位符名称，目标槽位缺少名称时拒绝；不会自动推测图片对应关系。组合位移与单轴通道、RGBA 与其它重叠颜色通道会明确报冲突，需要先用删除时间轴操作处理。RGB 与独立 Alpha 可并存。参考 `examples/copy-timelines.json`。

变形复制要求顶点数量、加权状态和附件类型一致，网格还要求相同的 UV 顶点索引及有向三角形拓扑；允许等价的三角形列表重排。加权顶点逐个核对影响骨骼身份，影响顺序不同时同步重排稀疏变形坐标。目标绑定位置和权重值不变，不自动按图形寻找对应点；目标绑定不同会改变最终运动。序列复制要求有效来源与目标的帧数相同。读取继承链接时取实际源网格的通道；写入仍继承时间轴的链接会拒绝，应选择源网格、关闭继承或先独立化。

`spine_retime_keyframes` 接受 `animation/targets/start/end/timeScale/timeOffset`，范围包含两端，支持选中单一时刻。范围内每个关键帧的新时间为：

```text
start + (oldTime - start) * timeScale + timeOffset
```

范围外的关键帧时间和数值不变；移动端点会改变相邻区间的播放时序。数值曲线按每个区间的新旧长度重算 Bezier 时间控制点，保留值控制点及归一化缓动，阶跃保留。不会在范围边界补关键帧。关键帧必须保持原有顺序，在 float32 精度下仍需可区分；原本同刻的事件一起移动，仍可同时触发。空范围、越过相邻关键帧、负时间、溢出或超过 300 秒都会拒绝。`sequence.delay` 是播放参数，**局部调时保留其值**；需要整个动画连同序列播放速度一起缩放时使用 `spine_retime_animation`。

分组绘制顺序先用 `flatten_draw_order` 转成全局通道；新工具不复制或局部编辑分组结构。每次最多选 100 个通道/映射、处理 100,000 个关键帧；复制的源通道最多 16 MiB、变形最多 5,000,000 个坐标，生成 JSON 不超过 32 MiB。两项编辑均接入工程、多骨架和后台任务。`examples/timeline-project.json` 从演示骨架创建另一骨骼和附件，复制局部动作及颜色并调整中间关键帧；`examples/background-timelines.json` 提交已有动作的后台编辑。使用前替换实际路径、对象、通道和关键帧时刻。

## 裁剪、拼接、镜像和烘焙

- `crop_animation` 需要原动画、未使用的 `newName` 和 `start/end/fps`。数值/曲线按指定帧率及原关键帧采样；颜色会量化为通道字节，序列转为采样的 hold 帧。保留范围内事件；裁剪前的物理历史不会自动烘焙。
- `merge_animations` 拼接 2–20 段动画，可设置非负 `gap`。各段必须有相同状态时间轴集合，且各时间轴从零时刻有明确键；存在分组时间轴时，可先用 `flatten_draw_order` 转成全局排列，再进行拼接。零间隔时，边界前预留十分之一个采样帧的保持窗口，避免编辑器把接近的时间吸附到同一帧。采样结果是近似值。
- `mirror_animation` 镜像指定轴的局部位移、旋转与错切偏移和曲线。可用 `bones` 限定骨骼；不会自动交换左右骨骼名、改变设置姿态或反射整套世界坐标骨架。
- `bake_animation` 生成独立骨架变体：只保留选定动画，移除约束定义/成员，并写入运行时计算后的骨骼关键帧。其它动画在这个新副本中省略。可选皮肤及物理模拟；Slider 源动画需仅含骨骼时间轴。根据 FPS 在采样点之间近似，不替代编辑器内的全功能烘焙。

以上操作可单独输出新 JSON，也可纳入工程编辑批次。参考 `examples/advanced-project.json`。

## 连续帧、多骨架和后台任务

`spine_export_frames` 接受 `options: { animation, skin, start, end, fps, kind, physics }`，`kind` 为 `artwork` 或 `bones`。一次最多 300 帧，包含起止时刻，全部使用同一视口。返回 PNG 文件、`frames.json` 清单和本地 `player.html`，不自动打开窗口，不播放音频。FPS 支持 1–120，时间范围 0–300 秒；复杂骨架和物理采样另有限额，会返回具体缩短建议。

`spine_build_project` 接受 `entries: [{ input, name, edits? }]` 与新 `.spine` 输出；最多 50 个不重名骨架。`spine_edit_multi_project` 接受源工程与 `changes: [{ name, edits }]`，重建、回导核对全部骨架。若只需查看其中一个骨架，先用 `spine_inspect` 的 `skeletonName` 选择，之后对返回的 `workingJson` 编辑。`spine_batch` 接受 `inputs/action/format/stopOnError`，每个文件返回结果，检查时处理全部骨架。参考 `examples/multi-project.json`。

长任务使用 `spine_start_job`。例如将 `examples/background-frames.json` 中的输入和动画名换成实际资源：

```powershell
npm run call -- spine_start_job --args-file examples/background-frames.json
```

返回 `id` 后，用 `spine_get_job { id, includeResult: true }` 查询，或 `spine_cancel_job { id }` 取消。支持 `edit_project/build_project/edit_multi_project/export_frames/batch` 五种受约束操作，不能执行任意脚本。状态为 `queued/running/succeeded/failed/cancelled`；返回阶段与阶段内计数，不提供总进度估算。

队列与结果持久存于工作目录 `.queue/`，隐藏独立 Node 进程按队列执行，MCP 连接关闭后继续工作。取消在阶段之间和发布前检查，已经启动的 CLI 命令会先结束；不会结束用户打开的 Spine。取消后的诊断文件和已渲染中间帧保留。重启机器或后台进程异常退出后，可调用 `spine_resume_jobs`：待运行任务继续；中断过的运行任务标记失败，供检查后重新提交。没有自动重试可能已经发布的操作。

## 数据保留与验证范围

- 目标 JSON 版本严格锁定 `4.3.23`。未知字段保留；不通过更改版本字符串转换旧格式。
- 修改生成新文件，既有文件不覆盖。原 `.spine` 不会被替换。导入文件先在目标目录内生成临时工程，检查工程版本后发布为目标文件。
- 导出开启 `nonessential`，关闭动画清理，开启全部导出。导出的图片和音频路径会重定位到生成 JSON 的位置，后续编辑移动目录时也会保留实际资源位置。
- JSON 往返不等同于完全复制编辑器内部数据，生产工程应保留原 `.spine`。参考 [Spine 导入说明](https://en.esotericsoftware.com/spine-import)。
- 骨骼预览使用官方 `spine-core 4.3.13` 运行时包，它的包版本与编辑器版本编号不同。预览是骨骼示意图，省略贴图和网格，可选择启用物理模拟；旧版本布局约束会明确报不支持。它不能替代最终游戏渲染的视觉验收。
- 带贴图的预览使用同一个官方运行时及本地 PNG，经内存中的 SVG 光栅化生成图片；无需浏览器、桌面窗口或 GPU。它的支持范围见上一节。
- 已验证本机 4.3.23 CLI 的 JSON → `.spine` → JSON 往返、五帧旋转值、图片路径、二进制导出及图集打包。未用 UI 打开测试工程做视觉验收；主窗口中尚未保存的更改不会自动出现在文件工具中。

## 参考与依赖

网格数据字段同时参考 [Spine 官方 JSON 格式](https://en.esotericsoftware.com/spine-json-format)，4.3 的具体解析和行为以锁定的官方运行时及本机导入导出验收为准。

本项目参考 [Spine 官方 CLI](https://en.esotericsoftware.com/spine-command-line-interface) 及现有 [spine-mcp-server](https://github.com/zhoushengmin/spine-mcp-server)、[spine-mcp](https://github.com/egorfedorov/spine-mcp) 的工具分层与命令行工作流，未引入它们锁定旧版本的实现。

依赖版本锁定在 `package-lock.json`。MCP 使用官方 TypeScript SDK v2。Spine Runtime 的许可见 `THIRD_PARTY_SPINE_LICENSE.txt`；其它依赖的许可随对应 npm 包提供。本服务不分发 Spine 编辑器或安装包。


`npm run smoke:cross-project` 额外验证官方 Raptor 的两个已保存工程之间进行根骨骼名称映射、动画迁移和完整骨架组合，并完成原生回写及姿态比较。

图集打包会在独立目录中读取图片副本，忽略输入目录内的 `pack.json`；需要自定义设置时使用 `spine_pack_atlas_configured` 的严格参数。交付时还会检查图集包含所有图片与序列帧区域。配置中的相对路径按配置文件所在目录解析，发布目录搬移不依赖启动工作目录。

