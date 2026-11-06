#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <bgfx/bgfx.h>
#include <bimg/decode.h>
#include <bx/allocator.h>
#include <bx/math.h>
#include <nlohmann/json.hpp>
#include <spine/spine.h>
#include <spine/SkeletonRenderer.h>
#include "spine_bgfx.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
namespace fs = std::filesystem;
namespace spine {
SpineExtension* getDefaultExtension() { return new DefaultSpineExtension(); }
}
static void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}
static std::string utf8(const fs::path& path) {
    const auto text = path.u8string();
    return {reinterpret_cast<const char*>(text.data()), text.size()};
}
static std::vector<uint8_t> readFile(const fs::path& path, size_t limit = 128 * 1024 * 1024) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    require(input.good(), "Cannot open file: " + utf8(path));
    const auto size = input.tellg();
    require(size >= 0 && static_cast<uint64_t>(size) <= limit, "File exceeds size limit: " + utf8(path));
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    input.seekg(0);
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    require(input.good() || bytes.empty(), "Cannot read complete file: " + utf8(path));
    return bytes;
}
static double milliseconds(Clock::duration value) { return std::chrono::duration<double, std::milli>(value).count(); }
static double finiteNumber(const Json& object, const char* key, double fallback, double minimum, double maximum) {
    const double value = object.value(key, fallback);
    require(std::isfinite(value) && value >= minimum && value <= maximum, std::string("Invalid ") + key);
    return value;
}
static uint32_t integer(const Json& object, const char* key, double fallback, double minimum, double maximum) {
    const double value = finiteNumber(object, key, fallback, minimum, maximum);
    require(std::floor(value) == value, std::string(key) + " must be an integer");
    return static_cast<uint32_t>(value);
}
template<class T> struct GpuHandle {
    T handle = BGFX_INVALID_HANDLE;
    GpuHandle() = default;
    GpuHandle(const GpuHandle&) = delete;
    GpuHandle& operator=(const GpuHandle&) = delete;
    ~GpuHandle() { if (bgfx::isValid(handle)) bgfx::destroy(handle); }
    void set(T value) { require(bgfx::isValid(value), "GPU resource allocation failed"); handle = value; }
};
static bgfx::RendererType::Enum rendererType(const std::string& name) {
    if (name == "d3d12") return bgfx::RendererType::Direct3D12;
    if (name == "d3d11") return bgfx::RendererType::Direct3D11;
    if (name == "vulkan") return bgfx::RendererType::Vulkan;
    if (name == "metal") return bgfx::RendererType::Metal;
    if (name == "opengl") return bgfx::RendererType::OpenGL;
    if (name == "auto") {
#ifdef _WIN32
        return bgfx::RendererType::Direct3D12;
#elif defined(__APPLE__)
        return bgfx::RendererType::Metal;
#else
        return bgfx::RendererType::Vulkan;
#endif
    }
    throw std::runtime_error("Unsupported renderer: " + name);
}
struct GpuContext {
    bool initialized = false;
    GpuContext(const Json& config, uint16_t width, uint16_t height) {
        bgfx::Init init;
        init.type = rendererType(config.value("renderer", "auto"));
        init.fallback = false;
        init.vendorId = config.value("gpuVendorId", uint16_t(0));
        init.deviceId = config.value("gpuDeviceId", uint16_t(0));
        // Headless bgfx requires a 0x0 swap chain. Output size belongs to the FBO.
        (void)width; (void)height;
        init.swapChain.width = 0;
        init.swapChain.height = 0;
        init.reset = BGFX_RESET_NONE;
        init.profile = true;
        init.swapChain.nwh = nullptr;
        initialized = bgfx::init(init);
        require(initialized, "bgfx could not initialize the requested offscreen backend");
    }
    ~GpuContext() { if (initialized) bgfx::shutdown(); }
};
struct PageTexture {
    GpuHandle<bgfx::TextureHandle> texture;
    bool pma = false;
};
class Textures : public spine::TextureLoader {
    bx::DefaultAllocator allocator;
    fs::path root;
public:
    uint64_t bytes = 0;
    std::vector<std::unique_ptr<PageTexture>> pages;
    explicit Textures(fs::path atlasRoot) : root(fs::weakly_canonical(atlasRoot)) {}
    void load(spine::AtlasPage& page, const spine::String& name) override {
        const auto file = fs::weakly_canonical(fs::u8path(name.buffer()));
        const auto relative = file.lexically_relative(root);
        require(!relative.empty() && *relative.begin() != "..", "Atlas texture must stay within the atlas directory");
        const auto encoded = readFile(file);
        bimg::ImageContainer info{};
        require(bimg::imageParseInfo(&allocator, info, encoded.data(), static_cast<uint32_t>(encoded.size())), "Cannot inspect atlas image: " + utf8(file));
        const uint64_t imageBytes = uint64_t(info.m_width) * info.m_height * 4;
        require(info.m_width && info.m_height && info.m_width <= bgfx::getCaps()->limits.maxTextureSize && info.m_height <= bgfx::getCaps()->limits.maxTextureSize,
                "Atlas image dimensions exceed GPU limits");
        require(imageBytes <= 256 * 1024 * 1024 && bytes + imageBytes <= 1024ull * 1024 * 1024, "Atlas decoded image memory limit exceeded");
        std::unique_ptr<bimg::ImageContainer, decltype(&bimg::imageFree)> image(
            bimg::imageParse(&allocator, encoded.data(), static_cast<uint32_t>(encoded.size()), bimg::TextureFormat::RGBA8), bimg::imageFree);
        require(image && image->m_width == info.m_width && image->m_height == info.m_height && image->m_format == bimg::TextureFormat::RGBA8,
                "Cannot decode RGBA atlas image: " + utf8(file));
        uint64_t flags = 0;
        if (page.uWrap == spine::TextureWrap_ClampToEdge) flags |= BGFX_SAMPLER_U_CLAMP;
        else if (page.uWrap == spine::TextureWrap_MirroredRepeat) flags |= BGFX_SAMPLER_U_MIRROR;
        if (page.vWrap == spine::TextureWrap_ClampToEdge) flags |= BGFX_SAMPLER_V_CLAMP;
        else if (page.vWrap == spine::TextureWrap_MirroredRepeat) flags |= BGFX_SAMPLER_V_MIRROR;
        if (page.minFilter == spine::TextureFilter_Nearest) flags |= BGFX_SAMPLER_MIN_POINT;
        if (page.magFilter == spine::TextureFilter_Nearest) flags |= BGFX_SAMPLER_MAG_POINT;
        require(page.minFilter == spine::TextureFilter_Linear || page.minFilter == spine::TextureFilter_Nearest,
                "Mipmapped atlas filters need a mipmapped texture; export with Linear or Nearest");
        auto loaded = std::make_unique<PageTexture>();
        loaded->pma = page.pma;
        loaded->texture.set(bgfx::createTexture2D(static_cast<uint16_t>(image->m_width), static_cast<uint16_t>(image->m_height), false, 1,
            bgfx::TextureFormat::RGBA8, flags, bgfx::copy(image->m_data, static_cast<uint32_t>(imageBytes))));
        page.width = static_cast<int>(image->m_width); page.height = static_cast<int>(image->m_height);
        page.texture = loaded.get();
        pages.push_back(std::move(loaded));
        bytes += imageBytes;
    }
    // Retain ownership, including when Atlas construction fails partway through.
    void unload(void*) override {}
};
struct Vertex { float x, y, z, u, v; uint8_t light[4], dark[4]; };
static void unpack(uint32_t color, uint8_t* rgba) {
    rgba[0] = static_cast<uint8_t>(color >> 16); rgba[1] = static_cast<uint8_t>(color >> 8);
    rgba[2] = static_cast<uint8_t>(color); rgba[3] = static_cast<uint8_t>(color >> 24);
}
static uint64_t blend(spine::BlendMode mode) {
    switch (mode) {
    case spine::BlendMode_Normal: return BGFX_STATE_BLEND_FUNC_SEPARATE(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA, BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA);
    case spine::BlendMode_Additive: return BGFX_STATE_BLEND_FUNC(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_ONE);
    case spine::BlendMode_Multiply: return BGFX_STATE_BLEND_FUNC_SEPARATE(BGFX_STATE_BLEND_DST_COLOR, BGFX_STATE_BLEND_INV_SRC_ALPHA, BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA);
    case spine::BlendMode_Screen: return BGFX_STATE_BLEND_FUNC_SEPARATE(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_COLOR, BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA);
    default: throw std::runtime_error("Unsupported Spine blend mode");
    }
}
class Renderer {
    GpuContext context;
    Textures textures;
    std::unique_ptr<spine::Atlas> atlas;
    std::unique_ptr<spine::SkeletonData> data;
    std::unique_ptr<spine::Skeleton> skeleton;
    std::unique_ptr<spine::AnimationStateData> stateData;
    std::unique_ptr<spine::AnimationState> state;
    spine::SkeletonRenderer geometry;
    GpuHandle<bgfx::ProgramHandle> program, yuvProgram;
    GpuHandle<bgfx::UniformHandle> sampler, params, yuvParams;
    GpuHandle<bgfx::TextureHandle> color, readback, packed;
    GpuHandle<bgfx::FrameBufferHandle> target, packedTarget;
    bool nv12 = false;
    uint16_t readWidth = 0, readHeight = 0;
    bgfx::VertexLayout layout;
    std::vector<uint8_t> pixels, flipped;
    uint32_t gpuFrame = 0;
    std::vector<std::string> playlist;
    std::string currentAnimation;
    uint32_t clipFrames = 90;
    bool paused = false, playlistActive = false;
    float speed = 1;
    double dt;
public:
    const uint16_t width, height;
    uint64_t triangles = 0, vertices = 0, batches = 0;
    double prepareMs = 0, readbackMs = 0;
    Renderer(const Json& config, uint16_t w, uint16_t h, double fps)
      : context(config, w, h), textures(fs::u8path(config.at("atlas").get<std::string>()).parent_path()), dt(1 / fps), width(w), height(h) {
        const auto* caps = bgfx::getCaps();
        require(config.value("gpuVendorId", uint16_t(0)) == 0 || caps->vendorId == config["gpuVendorId"].get<uint16_t>(), "Requested GPU vendor was not selected");
        require(config.value("gpuDeviceId", uint16_t(0)) == 0 || caps->deviceId == config["gpuDeviceId"].get<uint16_t>(), "Requested GPU device was not selected");
        const auto format = config.value("pixelFormat", std::string("rgba"));
        require(format == "rgba" || format == "nv12", "Unsupported output pixel format");
        nv12 = format == "nv12";
        require(!nv12 || (w % 4 == 0 && h % 2 == 0), "GPU NV12 needs width divisible by 4 and even height");
        readWidth = nv12 ? w / 4 : w; readHeight = nv12 ? h * 3 / 2 : h;
        require(readHeight <= caps->limits.maxTextureSize, "Packed NV12 texture exceeds GPU limits");
        require(bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::RGBA8, BGFX_TEXTURE_BLIT_DST | BGFX_TEXTURE_READ_BACK), "GPU lacks RGBA texture readback capability");
        require(caps->rendererType != bgfx::RendererType::Noop, "Noop rendering cannot satisfy GPU rendering");
        const bool hardware = caps->vendorId == 0x1002 || caps->vendorId == 0x10de || caps->vendorId == 0x8086 || caps->vendorId == 0x106b || caps->vendorId == 0x13b5 || caps->vendorId == 0x5143;
        require(hardware || config.value("allowSoftware", false), "Unrecognized/software GPU vendor; hardware rendering could not be confirmed");
        require(w <= caps->limits.maxTextureSize && h <= caps->limits.maxTextureSize, "Output dimensions exceed GPU limits");
        spine::Bone::setYDown(true);
        const fs::path atlasPath = fs::absolute(fs::u8path(config.at("atlas").get<std::string>()));
        auto atlasText = readFile(atlasPath, 8 * 1024 * 1024);
        const auto directory = utf8(atlasPath.parent_path());
        atlas = std::make_unique<spine::Atlas>(reinterpret_cast<const char*>(atlasText.data()), static_cast<int>(atlasText.size()), directory.c_str(), &textures);
        require(!textures.pages.empty(), "Atlas has no images");
        const auto skeletonPath = fs::u8path(config.at("skeleton").get<std::string>());
        auto bytes = readFile(skeletonPath);
        if (skeletonPath.extension() == ".json") {
            bytes.push_back(0);
            spine::SkeletonJson loader(*atlas);
            data.reset(loader.readSkeletonData(reinterpret_cast<const char*>(bytes.data())));
            if (!data) throw std::runtime_error(std::string("Cannot load Spine JSON: ") + loader.getError().buffer());
        } else {
            spine::SkeletonBinary loader(*atlas);
            data.reset(loader.readSkeletonData(bytes.data(), static_cast<int>(bytes.size())));
            if (!data) throw std::runtime_error(std::string("Cannot load Spine binary: ") + loader.getError().buffer());
        }
        require(std::string(data->getVersion().buffer()).rfind("4.3.", 0) == 0, "Only matching Spine 4.3 assets are supported");
        skeleton = std::make_unique<spine::Skeleton>(*data);
        const float scale = static_cast<float>(finiteNumber(config, "scale", height * .86 / std::max(1.0f, data->getHeight()), .00001, 10000));
        skeleton->setScale(scale, scale);
        skeleton->setPosition(static_cast<float>(finiteNumber(config, "x", width * .5, -100000, 100000)), static_cast<float>(finiteNumber(config, "y", height * .94, -100000, 100000)));
        stateData = std::make_unique<spine::AnimationStateData>(*data);
        stateData->setDefaultMix(static_cast<float>(finiteNumber(config, "mix", .2, 0, 30)));
        state = std::make_unique<spine::AnimationState>(*stateData);
        if (config.contains("playlist")) {
            playlist = config.at("playlist").get<std::vector<std::string>>();
            require(!playlist.empty() && playlist.size() <= 1000, "Playlist must have 1 to 1000 animations");
            for (const auto& name : playlist) require(data->findAnimation(name.c_str()) != nullptr, "Unknown playlist animation: " + name);
            clipFrames = static_cast<uint32_t>(finiteNumber(config, "clipFrames", 90, 1, 1000000));
            playlistActive = true;
            play(playlist[0], true, stateData->getDefaultMix());
        } else {
            const auto animation = config.value("animation", data->getAnimations().size() ? std::string(data->getAnimations()[0]->getName().buffer()) : "");
            if (!animation.empty()) play(animation, config.value("loop", true), 0);
        }
        const auto folder = fs::u8path(config.at("shaders").get<std::string>());
        const std::string profile = caps->rendererType == bgfx::RendererType::Vulkan ? "spirv" : caps->rendererType == bgfx::RendererType::Metal ? "metal" : caps->rendererType == bgfx::RendererType::OpenGL ? "glsl" : "dx11";
        auto loadShader = [&](const char* name) {
            const auto binary = readFile(folder / profile / name, 8 * 1024 * 1024);
            const auto handle = bgfx::createShader(bgfx::copy(binary.data(), static_cast<uint32_t>(binary.size())));
            require(bgfx::isValid(handle), "Compiled shader could not be loaded");
            return handle;
        };
        GpuHandle<bgfx::ShaderHandle> vertex, fragment;
        vertex.set(loadShader("vs_spine.bin")); fragment.set(loadShader("fs_spine.bin"));
        program.set(bgfx::createProgram(vertex.handle, fragment.handle, false));
        if (nv12) {
            GpuHandle<bgfx::ShaderHandle> yuvFragment; yuvFragment.set(loadShader("fs_nv12.bin"));
            yuvProgram.set(bgfx::createProgram(vertex.handle, yuvFragment.handle, false));
            yuvParams.set(bgfx::createUniform("u_yuvParams", bgfx::UniformType::Vec4));
        }
        sampler.set(bgfx::createUniform("s_texture", bgfx::UniformType::Sampler));
        params.set(bgfx::createUniform("u_textureParams", bgfx::UniformType::Vec4));
        layout.begin().add(bgfx::Attrib::Position, 3, bgfx::AttribType::Float).add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
            .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Uint8, true).add(bgfx::Attrib::Color1, 4, bgfx::AttribType::Uint8, true).end();
        require(layout.getStride() == sizeof(Vertex), "Vertex layout stride mismatch");
        const int msaa = config.value("msaa", 4);
        require(msaa == 1 || msaa == 4, "msaa must be 1 or 4");
        const uint64_t rtFlags = msaa == 4 ? BGFX_TEXTURE_RT_MSAA_X4 : BGFX_TEXTURE_RT;
        require(bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::RGBA8, rtFlags), "RGBA render target/MSAA unsupported");
        color.set(bgfx::createTexture2D(w, h, false, 1, bgfx::TextureFormat::RGBA8, rtFlags));
        target.set(bgfx::createFrameBuffer(1, &color.handle, false));
        readback.set(bgfx::createTexture2D(readWidth, readHeight, false, 1, bgfx::TextureFormat::RGBA8, BGFX_TEXTURE_BLIT_DST | BGFX_TEXTURE_READ_BACK));
        if (nv12) {
            packed.set(bgfx::createTexture2D(readWidth, readHeight, false, 1, bgfx::TextureFormat::RGBA8, BGFX_TEXTURE_RT));
            packedTarget.set(bgfx::createFrameBuffer(1, &packed.handle, false));
            bgfx::setViewFrameBuffer(1, packedTarget.handle);
            bgfx::setViewRect(1, 0, 0, readWidth, readHeight);
        }
        bgfx::setViewFrameBuffer(0, target.handle);
        bgfx::setViewRect(0, 0, 0, w, h);
        bgfx::setViewClear(0, BGFX_CLEAR_COLOR, config.value("background", uint32_t(0x1d2434ff)));
        bgfx::setViewMode(0, bgfx::ViewMode::Sequential);
        float projection[16];
        bx::mtxOrtho(projection, 0.0f, float(w), float(h), 0.0f, 0.0f, 100.0f, 0.0f, caps->homogeneousDepth);
        bgfx::setViewTransform(0, nullptr, projection);
        if (nv12) bgfx::setViewTransform(1, nullptr, projection);
        pixels.resize(size_t(readWidth) * readHeight * 4);
        if (caps->originBottomLeft) flipped.resize(pixels.size());
    }
    Json metadata() const {
        Json animations = Json::array(), skins = Json::array();
        for (size_t i = 0; i < data->getAnimations().size(); ++i) {
            auto* animation = data->getAnimations()[i];
            animations.push_back({{"name", animation->getName().buffer()}, {"duration", animation->getDuration()}});
        }
        for (size_t i = 0; i < data->getSkins().size(); ++i) skins.push_back(data->getSkins()[i]->getName().buffer());
        const auto* caps = bgfx::getCaps();
        return {{"renderer", bgfx::getRendererName(caps->rendererType)}, {"vendorId", caps->vendorId}, {"deviceId", caps->deviceId},
            {"width", width}, {"height", height}, {"pixelFormat", nv12 ? "nv12" : "rgba"}, {"rowStride", nv12 ? width : width * 4}, {"readbackBytesPerFrame", size_t(readWidth) * readHeight * 4}, {"colorSpace", nv12 ? "bt709-limited" : "rgb"}, {"spineVersion", data->getVersion().buffer()},
            {"bones", data->getBones().size()}, {"slots", data->getSlots().size()}, {"atlasPages", textures.pages.size()}, {"atlasTextureBytes", textures.bytes},
            {"animations", animations}, {"skins", skins}, {"offscreen", true}, {"nativeWindow", false}};
    }
    void play(const std::string& animation, bool loop, float mix) {
        auto* found = data->findAnimation(animation.c_str());
        require(found != nullptr, "Unknown animation: " + animation);
        state->setAnimation(0, *found, loop).setMixDuration(mix);
        currentAnimation = animation;
    }
    Json command(const Json& request, bool& shutdown) {
        require(request.is_object(), "Command must be an object");
        const auto method = request.at("method").get<std::string>();
        const auto options = request.value("params", Json::object());
        if (method == "play") {
            const auto name = options.at("animation").get<std::string>();
            const auto mix = static_cast<float>(finiteNumber(options, "mix", .2, 0, 30));
            play(name, options.value("loop", true), mix); playlistActive = false;
        } else if (method == "pause") paused = true;
        else if (method == "resume") paused = false;
        else if (method == "speed") speed = static_cast<float>(finiteNumber(options, "value", 1, 0, 8));
        else if (method == "transform") {
            const auto x = static_cast<float>(finiteNumber(options, "x", skeleton->getX(), -100000, 100000));
            const auto y = static_cast<float>(finiteNumber(options, "y", skeleton->getY(), -100000, 100000));
            const auto scale = static_cast<float>(finiteNumber(options, "scale", skeleton->getScaleX(), .00001, 10000));
            skeleton->setPosition(x, y); skeleton->setScale(scale, scale);
        } else if (method == "skin") {
            const auto name = options.at("name").get<std::string>();
            require(data->findSkin(name.c_str()) != nullptr, "Unknown skin: " + name);
            skeleton->setSkin(name.c_str()); skeleton->setupPoseSlots();
        } else if (method == "seek") {
            const auto time = static_cast<float>(finiteNumber(options, "time", 0, 0, 100000));
            require(!currentAnimation.empty(), "No active animation to seek");
            state->clearTracks(); skeleton->setupPose();
            state->setAnimation(0, currentAnimation.c_str(), options.value("loop", true)).setTrackTime(time);
            playlistActive = false; state->apply(*skeleton); skeleton->updateWorldTransform(spine::Physics_Reset);
        } else if (method == "shutdown") shutdown = true;
        else if (method != "status") throw std::runtime_error("Unknown command: " + method);
        return {{"animation", currentAnimation}, {"paused", paused}, {"speed", speed}, {"x", skeleton->getX()}, {"y", skeleton->getY()},
            {"scale", skeleton->getScaleX()}, {"stopping", shutdown}};
    }
    const std::vector<uint8_t>& frame(uint32_t index, bool capture) {
        const auto begin = Clock::now();
        if (playlistActive) {
            const auto& next = playlist[(index / clipFrames) % playlist.size()];
            if (next != currentAnimation) play(next, true, stateData->getDefaultMix());
        }
        const float step = paused ? 0.0f : static_cast<float>(dt) * speed;
        state->update(step); skeleton->update(step); state->apply(*skeleton);
        skeleton->updateWorldTransform(spine::Physics_Update);
        bgfx::touch(0);
        triangles = vertices = batches = 0;
        for (auto* command = geometry.render(*skeleton); command; command = command->next) {
            require(command->numVertices >= 0 && command->numVertices <= 65535 && command->numIndices >= 0 && command->numIndices <= 1000000,
                "Spine draw command exceeds buffer limits");
            bgfx::TransientVertexBuffer vb;
            bgfx::TransientIndexBuffer ib;
            require(bgfx::allocTransientBuffers(&vb, layout, static_cast<uint32_t>(command->numVertices), &ib, static_cast<uint32_t>(command->numIndices)), "GPU transient geometry capacity exceeded");
            auto* destination = reinterpret_cast<Vertex*>(vb.data);
            for (int i = 0; i < command->numVertices; ++i) {
                auto& vertex = destination[i];
                vertex.x = command->positions[i * 2]; vertex.y = command->positions[i * 2 + 1]; vertex.z = 0;
                require(std::isfinite(vertex.x) && std::isfinite(vertex.y), "Spine produced non-finite positions");
                vertex.u = command->uvs[i * 2]; vertex.v = command->uvs[i * 2 + 1];
                unpack(command->colors[i], vertex.light); unpack(command->darkColors[i], vertex.dark);
            }
            std::memcpy(ib.data, command->indices, static_cast<size_t>(command->numIndices) * sizeof(uint16_t));
            auto* page = static_cast<PageTexture*>(command->texture);
            require(page != nullptr, "Missing atlas texture for attachment");
            const float textureParams[4]{page->pma ? 1.0f : 0.0f, 0, 0, 0};
            bgfx::setUniform(params.handle, textureParams); bgfx::setTexture(0, sampler.handle, page->texture.handle);
            bgfx::setVertexBuffer(0, &vb); bgfx::setIndexBuffer(&ib);
            bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_MSAA | blend(command->blendMode));
            bgfx::submit(0, program.handle);
            vertices += command->numVertices; triangles += command->numIndices / 3; ++batches;
        }
        const auto submitted = Clock::now();
        if (capture) {
            if (nv12) {
                bgfx::TransientVertexBuffer vb; bgfx::TransientIndexBuffer ib;
                require(bgfx::allocTransientBuffers(&vb, layout, 4, &ib, 6), "NV12 conversion buffer allocation failed");
                auto* v = reinterpret_cast<Vertex*>(vb.data);
                const float xy[8]{0,0,float(width),0,float(width),float(height),0,float(height)};
                const float uv[8]{0,0,1,0,1,1,0,1};
                for (int i=0;i<4;++i) { v[i] = {}; v[i].x=xy[i*2];v[i].y=xy[i*2+1];v[i].u=uv[i*2];v[i].v=uv[i*2+1]; }
                const uint16_t indices[6]{0,1,2,0,2,3};std::memcpy(ib.data,indices,sizeof(indices));
                const float parameters[4]{float(width),float(height),0,bgfx::getCaps()->originBottomLeft?1.0f:0.0f};
                bgfx::setUniform(yuvParams.handle,parameters);
                bgfx::setTexture(0,sampler.handle,color.handle,BGFX_SAMPLER_MIN_POINT|BGFX_SAMPLER_MAG_POINT|BGFX_SAMPLER_U_CLAMP|BGFX_SAMPLER_V_CLAMP);
                bgfx::setVertexBuffer(0,&vb);bgfx::setIndexBuffer(&ib);
                bgfx::setState(BGFX_STATE_WRITE_RGB|BGFX_STATE_WRITE_A);bgfx::submit(1,yuvProgram.handle);
            }
            bgfx::blit(2, {.handle = readback.handle}, {.handle = nv12 ? packed.handle : color.handle});
            const uint32_t ready = bgfx::read({.handle = readback.handle}, pixels.data());
            int advance = 0;
            do {
                gpuFrame = bgfx::frame();
                require(++advance <= 64 && milliseconds(Clock::now() - submitted) < 10000, "GPU readback did not complete");
            } while (static_cast<int32_t>(gpuFrame - ready) < 0);
            if (!flipped.empty()) {
                const size_t row = size_t(readWidth) * 4;
                for (size_t y = 0; y < readHeight; ++y) std::memcpy(flipped.data() + y * row, pixels.data() + (readHeight - y - 1) * row, row);
            }
        } else gpuFrame = bgfx::frame();
        prepareMs = milliseconds(submitted - begin); readbackMs = milliseconds(Clock::now() - submitted);
        return flipped.empty() ? pixels : flipped;
    }
};
static std::atomic<bool> rendererActive{false};
struct sbgfx_renderer {
    std::unique_ptr<Renderer> value;
    std::thread::id owner;
};
static void copyError(char* destination, uint32_t capacity, const char* source) noexcept {
    if (!destination || capacity == 0) return;
    const size_t size = std::min<size_t>(std::strlen(source), capacity - 1);
    std::memcpy(destination, source, size);
    destination[size] = 0;
}
static void checkOwner(sbgfx_renderer* renderer) {
    require(renderer && renderer->value, "Renderer handle is null");
    require(renderer->owner == std::this_thread::get_id(), "Renderer must be called on its owning OS thread");
}
static int32_t copyJson(const Json& value, char* result, uint32_t capacity) {
    const auto text = value.dump();
    require(result && text.size() + 1 <= capacity, "JSON result buffer is too small");
    std::memcpy(result, text.c_str(), text.size() + 1);
    return static_cast<int32_t>(text.size());
}
extern "C" {
uint32_t sbgfx_abi_version(void) { return 1; }
sbgfx_renderer* sbgfx_create(const char* config_json, const char* shader_directory, char* error, uint32_t error_capacity) {
    bool acquired = false;
    try {
        require(config_json && shader_directory, "Config and shader directory are required");
        acquired = !rendererActive.exchange(true);
        require(acquired, "Only one bgfx renderer is allowed per worker process");
        auto config = Json::parse(config_json);
        if (!config.contains("shaders")) config["shaders"] = shader_directory;
        const auto width = static_cast<uint16_t>(integer(config, "width", 1280, 64, 4096));
        const auto height = static_cast<uint16_t>(integer(config, "height", 720, 64, 4096));
        const double fps = finiteNumber(config, "fps", 30, 1, 120);
        auto renderer = std::make_unique<sbgfx_renderer>();
        renderer->owner = std::this_thread::get_id();
        renderer->value = std::make_unique<Renderer>(config, width, height, fps);
        return renderer.release();
    } catch (const std::exception& exception) {
        if (acquired) rendererActive = false;
        copyError(error, error_capacity, exception.what()); return nullptr;
    } catch (...) {
        if (acquired) rendererActive = false;
        copyError(error, error_capacity, "Unknown native initialization error"); return nullptr;
    }
}
int32_t sbgfx_info(sbgfx_renderer* renderer, char* result, uint32_t capacity, char* error, uint32_t error_capacity) {
    try { checkOwner(renderer); return copyJson(renderer->value->metadata(), result, capacity); }
    catch (const std::exception& exception) { copyError(error, error_capacity, exception.what()); return -1; }
    catch (...) { copyError(error, error_capacity, "Unknown native metadata error"); return -1; }
}
int32_t sbgfx_step(sbgfx_renderer* renderer, uint32_t index, int32_t capture, sbgfx_frame* result, char* error, uint32_t error_capacity) {
    try {
        checkOwner(renderer); require(result != nullptr, "Frame result pointer is null");
        const auto& pixels = renderer->value->frame(index, capture != 0);
        result->pixels = capture ? pixels.data() : nullptr;
        result->size = capture ? static_cast<uint32_t>(pixels.size()) : 0;
        result->vertices = static_cast<uint32_t>(renderer->value->vertices);
        result->triangles = static_cast<uint32_t>(renderer->value->triangles);
        result->batches = static_cast<uint32_t>(renderer->value->batches);
        result->prepare_ms = renderer->value->prepareMs;
        result->readback_ms = renderer->value->readbackMs;
        return 0;
    } catch (const std::exception& exception) { copyError(error, error_capacity, exception.what()); return -1; }
    catch (...) { copyError(error, error_capacity, "Unknown native rendering error"); return -1; }
}
int32_t sbgfx_command(sbgfx_renderer* renderer, const char* request, char* result, uint32_t capacity, char* error, uint32_t error_capacity) {
    try {
        checkOwner(renderer); require(request != nullptr, "Command pointer is null");
        bool shutdown = false;
        return copyJson(renderer->value->command(Json::parse(request), shutdown), result, capacity);
    } catch (const std::exception& exception) { copyError(error, error_capacity, exception.what()); return -1; }
    catch (...) { copyError(error, error_capacity, "Unknown native command error"); return -1; }
}
int32_t sbgfx_destroy(sbgfx_renderer* renderer, char* error, uint32_t error_capacity) {
    if (!renderer) return 0;
    try { checkOwner(renderer); delete renderer; rendererActive = false; return 0; }
    catch (const std::exception& exception) { copyError(error, error_capacity, exception.what()); return -1; }
    catch (...) { copyError(error, error_capacity, "Unknown native shutdown error"); return -1; }
}
}
