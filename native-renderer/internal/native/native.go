//go:build cgo

package native

/*
#cgo linux LDFLAGS: -ldl
#include <stdlib.h>
#include "bridge.h"
*/
import "C"
import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"unsafe"
)

// Engine is thread-affine. Its owner must runtime.LockOSThread from Open
// through Close. The worker loop enforces this and serializes all native calls.
type Engine struct {
	library  *C.sbgfx_bridge
	renderer *C.sbgfx_renderer
}

const errorSize = 8192
const jsonSize = 1024 * 1024

func nativeError(b []byte) error { return errors.New(C.GoString((*C.char)(unsafe.Pointer(&b[0])))) }
func Open(library, shaders string, config any) (*Engine, error) {
	full, err := filepath.Abs(library)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	if len(encoded) > jsonSize {
		return nil, errors.New("native config exceeds 1 MiB")
	}
	name, input, shaderDir := C.CString(full), C.CString(string(encoded)), C.CString(shaders)
	defer C.free(unsafe.Pointer(name))
	defer C.free(unsafe.Pointer(input))
	defer C.free(unsafe.Pointer(shaderDir))
	detail := make([]byte, errorSize)
	b := C.bridge_load(name, (*C.char)(unsafe.Pointer(&detail[0])), errorSize)
	if b == nil {
		return nil, nativeError(detail)
	}
	r := C.bridge_create(b, input, shaderDir, (*C.char)(unsafe.Pointer(&detail[0])), errorSize)
	if r == nil {
		C.bridge_unload(b)
		return nil, nativeError(detail)
	}
	return &Engine{b, r}, nil
}
func (e *Engine) Info() (Info, error) {
	var info Info
	if e.renderer == nil {
		return info, errors.New("renderer is closed")
	}
	result, detail := make([]byte, jsonSize), make([]byte, errorSize)
	n := C.bridge_info(e.library, e.renderer, (*C.char)(unsafe.Pointer(&result[0])), jsonSize, (*C.char)(unsafe.Pointer(&detail[0])), errorSize)
	if n < 0 {
		return info, nativeError(detail)
	}
	if err := json.Unmarshal(result[:int(n)], &info); err != nil {
		return Info{}, err
	}
	return info, nil
}
func (e *Engine) Step(index uint32, capture bool) (Frame, error) {
	var frame Frame
	if e.renderer == nil {
		return frame, errors.New("renderer is closed")
	}
	detail := make([]byte, errorSize)
	var result C.sbgfx_frame
	var read C.int32_t
	if capture {
		read = 1
	}
	if C.bridge_step(e.library, e.renderer, C.uint32_t(index), read, &result, (*C.char)(unsafe.Pointer(&detail[0])), errorSize) != 0 {
		return frame, nativeError(detail)
	}
	if result.size > 4096*4096*4 || (result.size > 0 && result.pixels == nil) {
		return frame, errors.New("native frame has invalid storage")
	}
	if result.size > 0 {
		frame.Pixels = unsafe.Slice((*byte)(unsafe.Pointer(result.pixels)), int(result.size))
	}
	frame.Vertices, frame.Triangles, frame.Batches = uint32(result.vertices), uint32(result.triangles), uint32(result.batches)
	frame.PrepareMS, frame.ReadbackMS = float64(result.prepare_ms), float64(result.readback_ms)
	return frame, nil
}
func (e *Engine) Command(command Command) (map[string]any, error) {
	if e.renderer == nil {
		return nil, errors.New("renderer is closed")
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		return nil, err
	}
	if len(encoded) > jsonSize {
		return nil, errors.New("command exceeds 1 MiB")
	}
	input := C.CString(string(encoded))
	defer C.free(unsafe.Pointer(input))
	result, detail := make([]byte, jsonSize), make([]byte, errorSize)
	n := C.bridge_command(e.library, e.renderer, input, (*C.char)(unsafe.Pointer(&result[0])), jsonSize, (*C.char)(unsafe.Pointer(&detail[0])), errorSize)
	if n < 0 {
		return nil, nativeError(detail)
	}
	var response map[string]any
	if err := json.Unmarshal(result[:int(n)], &response); err != nil {
		return nil, fmt.Errorf("invalid native response: %w", err)
	}
	return response, nil
}
func (e *Engine) Close() error {
	if e.renderer == nil {
		return nil
	}
	detail := make([]byte, errorSize)
	if C.bridge_destroy(e.library, e.renderer, (*C.char)(unsafe.Pointer(&detail[0])), errorSize) != 0 {
		return nativeError(detail)
	}
	e.renderer = nil
	C.bridge_unload(e.library)
	e.library = nil
	return nil
}
