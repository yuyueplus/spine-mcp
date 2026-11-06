//go:build cgo

#include "bridge.h"
#include <stdlib.h>
#include <stdio.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif
struct sbgfx_bridge {
#ifdef _WIN32
    HMODULE module;
#else
    void* module;
#endif
    uint32_t (*version)(void);
    sbgfx_renderer* (*create)(const char*, const char*, char*, uint32_t);
    int32_t (*info)(sbgfx_renderer*, char*, uint32_t, char*, uint32_t);
    int32_t (*step)(sbgfx_renderer*, uint32_t, int32_t, sbgfx_frame*, char*, uint32_t);
    int32_t (*command)(sbgfx_renderer*, const char*, char*, uint32_t, char*, uint32_t);
    int32_t (*destroy)(sbgfx_renderer*, char*, uint32_t);
};
static void* symbol(sbgfx_bridge* bridge, const char* name) {
#ifdef _WIN32
    return (void*)GetProcAddress(bridge->module, name);
#else
    return dlsym(bridge->module, name);
#endif
}
sbgfx_bridge* bridge_load(const char* file, char* error, uint32_t capacity) {
    sbgfx_bridge* bridge = (sbgfx_bridge*)calloc(1, sizeof(sbgfx_bridge));
    if (!bridge) { snprintf(error, capacity, "Cannot allocate native library loader"); return NULL; }
#ifdef _WIN32
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, file, -1, NULL, 0);
    wchar_t* path = length > 0 ? (wchar_t*)calloc((size_t)length, sizeof(wchar_t)) : NULL;
    if (path) {
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, file, -1, path, length);
        bridge->module = LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        free(path);
    }
    if (!bridge->module) snprintf(error, capacity, "Cannot load native renderer DLL (Windows error %lu)", (unsigned long)GetLastError());
#else
    bridge->module = dlopen(file, RTLD_NOW | RTLD_LOCAL);
    if (!bridge->module) snprintf(error, capacity, "Cannot load native renderer: %s", dlerror());
#endif
    if (!bridge->module) { free(bridge); return NULL; }
    bridge->version = (uint32_t (*)(void))symbol(bridge, "sbgfx_abi_version");
    bridge->create = (sbgfx_renderer* (*)(const char*, const char*, char*, uint32_t))symbol(bridge, "sbgfx_create");
    bridge->info = (int32_t (*)(sbgfx_renderer*, char*, uint32_t, char*, uint32_t))symbol(bridge, "sbgfx_info");
    bridge->step = (int32_t (*)(sbgfx_renderer*, uint32_t, int32_t, sbgfx_frame*, char*, uint32_t))symbol(bridge, "sbgfx_step");
    bridge->command = (int32_t (*)(sbgfx_renderer*, const char*, char*, uint32_t, char*, uint32_t))symbol(bridge, "sbgfx_command");
    bridge->destroy = (int32_t (*)(sbgfx_renderer*, char*, uint32_t))symbol(bridge, "sbgfx_destroy");
    if (!bridge->version || !bridge->create || !bridge->info || !bridge->step || !bridge->command || !bridge->destroy || bridge->version() != 1) {
        snprintf(error, capacity, "Native renderer ABI is incomplete or incompatible"); bridge_unload(bridge); return NULL;
    }
    return bridge;
}
void bridge_unload(sbgfx_bridge* bridge) {
    if (!bridge) return;
#ifdef _WIN32
    FreeLibrary(bridge->module);
#else
    dlclose(bridge->module);
#endif
    free(bridge);
}
sbgfx_renderer* bridge_create(sbgfx_bridge* b, const char* config, const char* shaders, char* e, uint32_t n) { return b->create(config, shaders, e, n); }
int32_t bridge_info(sbgfx_bridge* b, sbgfx_renderer* r, char* out, uint32_t c, char* e, uint32_t n) { return b->info(r, out, c, e, n); }
int32_t bridge_step(sbgfx_bridge* b, sbgfx_renderer* r, uint32_t index, int32_t capture, sbgfx_frame* out, char* e, uint32_t n) { return b->step(r, index, capture, out, e, n); }
int32_t bridge_command(sbgfx_bridge* b, sbgfx_renderer* r, const char* command, char* out, uint32_t c, char* e, uint32_t n) { return b->command(r, command, out, c, e, n); }
int32_t bridge_destroy(sbgfx_bridge* b, sbgfx_renderer* r, char* e, uint32_t n) { return b->destroy(r, e, n); }
