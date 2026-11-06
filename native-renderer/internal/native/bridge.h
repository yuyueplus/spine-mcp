#ifndef SBGFX_BRIDGE_H
#define SBGFX_BRIDGE_H
#include "../../include/spine_bgfx.h"
typedef struct sbgfx_bridge sbgfx_bridge;
sbgfx_bridge* bridge_load(const char* file, char* error, uint32_t capacity);
void bridge_unload(sbgfx_bridge*);
sbgfx_renderer* bridge_create(sbgfx_bridge*, const char*, const char*, char*, uint32_t);
int32_t bridge_info(sbgfx_bridge*, sbgfx_renderer*, char*, uint32_t, char*, uint32_t);
int32_t bridge_step(sbgfx_bridge*, sbgfx_renderer*, uint32_t, int32_t, sbgfx_frame*, char*, uint32_t);
int32_t bridge_command(sbgfx_bridge*, sbgfx_renderer*, const char*, char*, uint32_t, char*, uint32_t);
int32_t bridge_destroy(sbgfx_bridge*, sbgfx_renderer*, char*, uint32_t);
#endif
