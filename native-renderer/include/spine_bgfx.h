#ifndef SPINE_BGFX_H
#define SPINE_BGFX_H
#include <stdint.h>
#if defined(_WIN32) && defined(SBGFX_LIBRARY_BUILD)
#define SBGFX_API __declspec(dllexport)
#elif defined(__GNUC__)
#define SBGFX_API __attribute__((visibility("default")))
#else
#define SBGFX_API
#endif
#ifdef __cplusplus
extern "C" {
#endif
typedef struct sbgfx_renderer sbgfx_renderer;
typedef struct sbgfx_frame {
    const uint8_t* pixels;
    uint32_t size;
    uint32_t vertices;
    uint32_t triangles;
    uint32_t batches;
    double prepare_ms;
    double readback_ms;
} sbgfx_frame;
/* One renderer per process. Create, step, command and destroy on the same OS
 * thread. Frame pixels are C-owned and valid until the next step or destroy.
 * No Go pointer or caller-owned buffer is retained. All functions catch C++
 * exceptions and report an error instead of crossing the ABI boundary. */
SBGFX_API uint32_t sbgfx_abi_version(void);
SBGFX_API sbgfx_renderer* sbgfx_create(const char* config_json, const char* shader_directory, char* error, uint32_t error_capacity);
SBGFX_API int32_t sbgfx_info(sbgfx_renderer*, char* result, uint32_t capacity, char* error, uint32_t error_capacity);
SBGFX_API int32_t sbgfx_step(sbgfx_renderer*, uint32_t frame_index, int32_t capture, sbgfx_frame* result, char* error, uint32_t error_capacity);
SBGFX_API int32_t sbgfx_command(sbgfx_renderer*, const char* request_json, char* result, uint32_t capacity, char* error, uint32_t error_capacity);
SBGFX_API int32_t sbgfx_destroy(sbgfx_renderer*, char* error, uint32_t error_capacity);
#ifdef __cplusplus
}
#endif
#endif
