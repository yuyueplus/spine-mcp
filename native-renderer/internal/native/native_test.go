//go:build cgo

package native

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMissingLibraryReturnsError(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if _, err := Open(filepath.Join(t.TempDir(), "missing-library"), "", map[string]any{}); err == nil {
		t.Fatal("missing library unexpectedly loaded")
	}
}
func nativeLibrary(t *testing.T) string {
	t.Helper()
	file := os.Getenv("SBGFX_TEST_LIBRARY")
	if file == "" {
		t.Skip("set SBGFX_TEST_LIBRARY to run real GPU integration tests")
	}
	file, err := filepath.Abs(file)
	if err != nil {
		t.Fatal(err)
	}
	return file
}
func fixture(t *testing.T, mode string, pma, dark, clipping, mesh, weighted bool) map[string]any {
	t.Helper()
	dir := t.TempDir()
	texture := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	rgba := color.NRGBA{200, 100, 50, 128}
	if pma {
		rgba = color.NRGBA{100, 50, 25, 128}
	}
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			texture.SetNRGBA(x, y, rgba)
		}
	}
	f, err := os.Create(filepath.Join(dir, "texture.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(f, texture); err != nil {
		t.Fatal(err)
	}
	f.Close()
	atlas := "texture.png\nsize:16,16\nfilter:Linear,Linear\npma:"
	if pma {
		atlas += "true"
	} else {
		atlas += "false"
	}
	atlas += "\nregion\nbounds:0,0,16,16\n"
	if err = os.WriteFile(filepath.Join(dir, "skeleton.atlas"), []byte(atlas), 0600); err != nil {
		t.Fatal(err)
	}
	slot := map[string]any{"name": "quad", "bone": "root", "attachment": "region", "blend": mode}
	if dark {
		slot["dark"] = "0000ff"
	}
	slots := []any{slot}
	attachment := map[string]any{"type": "region", "path": "region", "width": 100, "height": 100}
	if mesh {
		attachment["type"] = "mesh"
		attachment["uvs"] = []float64{0, 0, 1, 0, 1, 1, 0, 1}
		attachment["triangles"] = []int{0, 1, 2, 2, 3, 0}
		attachment["hull"] = 4
		attachment["vertices"] = []float64{-50, -50, 50, -50, 50, 50, -50, 50}
		if weighted {
			attachment["vertices"] = []float64{1, 0, -50, -50, 1, 1, 0, 50, -50, 1, 1, 0, 50, 50, 1, 1, 0, -50, 50, 1}
		}
	}
	attachments := map[string]any{"quad": map[string]any{"region": attachment}}
	if clipping {
		slots = append([]any{map[string]any{"name": "mask", "bone": "root", "attachment": "clip"}}, slots...)
		attachments["mask"] = map[string]any{"clip": map[string]any{"type": "clipping", "end": "quad", "vertexCount": 4, "vertices": []int{-50, -50, -10, -50, -10, 50, -50, 50}}}
	}
	skeleton := map[string]any{"skeleton": map[string]any{"spine": "4.3.23", "width": 100, "height": 100}, "bones": []any{map[string]any{"name": "root"}}, "slots": slots, "skins": []any{map[string]any{"name": "default", "attachments": attachments}}, "animations": map[string]any{"idle": map[string]any{}}}
	encoded, err := json.Marshal(skeleton)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "skeleton.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	renderer := os.Getenv("SBGFX_TEST_RENDERER")
	if renderer == "" {
		renderer = "auto"
	}
	return map[string]any{"skeleton": filepath.Join(dir, "skeleton.json"), "atlas": filepath.Join(dir, "skeleton.atlas"), "width": 256, "height": 256, "fps": 30, "msaa": 1, "x": 128, "y": 128, "scale": 1, "animation": "idle", "renderer": renderer}
}
func pixel(pixels []byte, x, y int) [3]uint8 {
	p := (y*256 + x) * 4
	return [3]uint8{pixels[p], pixels[p+1], pixels[p+2]}
}
func near(t *testing.T, actual [3]uint8, expected [3]float64) {
	t.Helper()
	for c := 0; c < 3; c++ {
		if math.Abs(float64(actual[c])-expected[c]) > 2.5 {
			t.Fatalf("actual=%v expected=%v", actual, expected)
		}
	}
}
func TestGPUBlendModesAndPMA(t *testing.T) {
	library := nativeLibrary(t)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for _, pma := range []bool{false, true} {
		for _, mode := range []string{"normal", "additive", "multiply", "screen"} {
			t.Run(mode+map[bool]string{false: "-straight", true: "-pma"}[pma], func(t *testing.T) {
				runtime.LockOSThread()
				defer runtime.UnlockOSThread()
				e, err := Open(library, filepath.Join(filepath.Dir(library), "shaders"), fixture(t, mode, pma, false, false, false, false))
				if err != nil {
					t.Fatal(err)
				}
				defer func() {
					if err := e.Close(); err != nil {
						t.Error(err)
					}
				}()
				frame, err := e.Step(0, true)
				if err != nil {
					t.Fatal(err)
				}
				a := 128.0 / 255
				src := [3]float64{200 * a, 100 * a, 50 * a}
				if pma {
					src = [3]float64{100, 50, 25}
				}
				bg := [3]float64{29, 36, 52}
				var expected [3]float64
				for c := 0; c < 3; c++ {
					switch mode {
					case "normal":
						expected[c] = src[c] + bg[c]*(1-a)
					case "additive":
						expected[c] = src[c] + bg[c]
					case "multiply":
						expected[c] = src[c]*bg[c]/255 + bg[c]*(1-a)
					case "screen":
						expected[c] = src[c] + bg[c]*(1-src[c]/255)
					}
				}
				near(t, pixel(frame.Pixels, 128, 128), expected)
			})
		}
	}
}
func TestGPUClippingMeshesAndDarkTint(t *testing.T) {
	library := nativeLibrary(t)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for _, variant := range []struct {
		name                       string
		dark, clip, mesh, weighted bool
	}{{"dark", true, false, false, false}, {"clipping", false, true, false, false}, {"mesh", false, false, true, false}, {"weighted-mesh", false, false, true, true}} {
		t.Run(variant.name, func(t *testing.T) {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			e, err := Open(library, filepath.Join(filepath.Dir(library), "shaders"), fixture(t, "normal", false, variant.dark, variant.clip, variant.mesh, variant.weighted))
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			frame, err := e.Step(0, true)
			if err != nil {
				t.Fatal(err)
			}
			if variant.clip {
				near(t, pixel(frame.Pixels, 100, 128), [3]float64{115, 68, 51})
				near(t, pixel(frame.Pixels, 140, 128), [3]float64{29, 36, 52})
			} else {
				expected := [3]float64{115, 68, 51}
				if variant.dark {
					expected[2] = 154
				}
				near(t, pixel(frame.Pixels, 128, 128), expected)
			}
		})
	}
}
func TestGPULifecycleThreadOwnershipAndControls(t *testing.T) {
	library := nativeLibrary(t)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	config := fixture(t, "normal", false, false, false, false, false)
	e, err := Open(library, filepath.Join(filepath.Dir(library), "shaders"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	info, err := e.Info()
	if err != nil || info.Width != 256 || info.NativeWindow || !info.Offscreen {
		t.Fatal(info, err)
	}
	if second, err := Open(library, filepath.Join(filepath.Dir(library), "shaders"), config); err == nil {
		second.Close()
		t.Fatal("second renderer unexpectedly initialized")
	}
	wrongThread := make(chan error, 1)
	go func() { _, err := e.Info(); wrongThread <- err }()
	if err = <-wrongThread; err == nil || !strings.Contains(err.Error(), "owning OS thread") {
		t.Fatal("thread check", err)
	}
	if _, err = e.Command(Command{Method: "pause"}); err != nil {
		t.Fatal(err)
	}
	first, err := e.Step(0, true)
	if err != nil {
		t.Fatal(err)
	}
	copyFirst := append([]byte(nil), first.Pixels...)
	second, err := e.Step(1, true)
	if err != nil || !bytes.Equal(copyFirst, second.Pixels) {
		t.Fatal("paused frame changed", err)
	}
	if _, err = e.Command(Command{Method: "transform", Params: map[string]any{"x": 168}}); err != nil {
		t.Fatal(err)
	}
	third, err := e.Step(2, true)
	if err != nil {
		t.Fatal(err)
	}
	near(t, pixel(third.Pixels, 90, 128), [3]float64{29, 36, 52})
	near(t, pixel(third.Pixels, 168, 128), [3]float64{115, 68, 51})
	if _, err = e.Command(Command{Method: "play", Params: map[string]any{"animation": "missing"}}); err == nil {
		t.Fatal("missing animation accepted")
	}
	if _, err = e.Command(Command{Method: "skin", Params: map[string]any{"name": "default"}}); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Command(Command{Method: "seek", Params: map[string]any{"time": 0.0}}); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Command(Command{Method: "resume"}); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Command(Command{Method: "speed", Params: map[string]any{"value": .5}}); err != nil {
		t.Fatal(err)
	}
	if err = e.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Info(); err == nil {
		t.Fatal("closed renderer accepted metadata call")
	}
	reopened, err := Open(library, filepath.Join(filepath.Dir(library), "shaders"), config)
	if err != nil {
		t.Fatal("reopen", err)
	}
	if err = reopened.Close(); err != nil {
		t.Fatal(err)
	}
}
