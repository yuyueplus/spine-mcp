package broadcast

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
)

const Duration = 117.0
const FPS = 30

var SettledAt = []float64{36, 41, 45, 50, 55, 59, 64}
var namePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)
var colorSets = map[string][]int{
	"red":   {1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46},
	"blue":  {3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48},
	"green": {5, 6, 11, 16, 17, 21, 22, 27, 28, 32, 33, 38, 39, 43, 44, 49},
}

type Request struct {
	Mode           string `json:"mode"`
	RoundID        string `json:"roundId"`
	RequestID      string `json:"requestId"`
	RegularNumbers []int  `json:"regularNumbers"`
	SpecialNumber  int    `json:"specialNumber"`
}

func (r Request) Numbers() []int {
	return append(append([]int(nil), r.RegularNumbers...), r.SpecialNumber)
}
func (r Request) Validate() error {
	if r.Mode != "scripted_demo" || !namePattern.MatchString(r.RoundID) || len(r.RequestID) < 8 || !namePattern.MatchString(r.RequestID) {
		return errors.New("mode must be scripted_demo; roundId/requestId must be bounded ASCII identifiers")
	}
	if len(r.RegularNumbers) != 6 {
		return errors.New("six regular numbers and one special number are required")
	}
	seen := map[int]bool{}
	for _, n := range r.Numbers() {
		if n < 1 || n > 49 || seen[n] {
			return errors.New("this demonstration uses seven distinct numbers within1..49")
		}
		seen[n] = true
	}
	return nil
}

func Color(number int) string {
	for name, values := range colorSets {
		for _, n := range values {
			if n == number {
				return name
			}
		}
	}
	return ""
}

func Phase(second float64) string {
	switch {
	case second < 24:
		return "准备与开场"
	case second < 34.6:
		return "球舱搅拌"
	case second < 65:
		return "依次出球"
	case second < 69:
		return "彩球落定"
	case second < 99:
		return "结果展示"
	case second < 102:
		return "演出收尾"
	default:
		return "最终结果"
	}
}

func Revealed(second float64) int {
	n := 0
	for _, t := range revealTimes() {
		if second >= t {
			n++
		}
	}
	return n
}

func binding(r Request) []int {
	numbers := r.Numbers()
	used := map[int]bool{}
	for _, n := range numbers {
		used[n] = true
	}
	for n := 1; n <= 49; n++ {
		if !used[n] {
			numbers = append(numbers, n)
		}
	}
	return numbers
}

type point struct{ x, y, depth float64 }

func clamp(v, a, b float64) float64 { return math.Max(a, math.Min(b, v)) }
func smooth(v float64) float64      { v = clamp(v, 0, 1); return v * v * (3 - 2*v) }
func mix(a, b, t float64) float64   { return a + (b-a)*t }
func pile(i int) point {
	return restingPosition(i, false)
}
func stirring(i int, second float64) point {
	f := float64(i)
	t := second - 24
	x := math.Sin(t*(2.15+math.Mod(f, 7)*.09)+f*2.399)*54 + math.Sin(t*3.1+f)*15
	y := 450 + math.Sin(t*(1.66+math.Mod(f, 5)*.085)+f*1.731)*26 + math.Sin(t*3.1+f*2.17)*15
	dx, dy := x, y-382
	if length := math.Hypot(dx, dy); length > 120 {
		x *= 120 / length
		y = 382 + dy*120/length
	}
	return point{618 + x, y, math.Sin(t*1.7 + f*2.399)}
}
func chamber(i int, t float64) point {
	p := pile(i)
	if t <= 24 {
		return p
	}
	m := stirring(i, t)
	in := smooth((t - 24) / 1.3)
	m.x = mix(p.x, m.x, in)
	m.y = mix(p.y, m.y, in)
	if t > 65 {
		p = restingPosition(i, true)
		out := smooth((t - 65) / 4)
		m.x = mix(m.x, p.x, out)
		m.y = mix(m.y, p.y, out)
		m.depth = mix(m.depth, p.depth, out)
	}
	return m
}

var rack = []point{{475, 419, 1}, {471, 401, 1}, {469, 382, 1}, {469, 363, 1}, {473, 343, 1}, {481, 323, 1}, {770, 414, 1}}

func mainPosition(i int, t float64) point {
	if i >= 7 || t < captureStart(i) {
		return chamber(i, t)
	}
	if t < releaseTime(i) {
		return airliftPosition(i, t)
	}
	return outerTrackPosition(i, t)
}
func zoomPosition(i int, t float64) point {
	return magnifierFor(i).project(mainPosition(i, t))
}

func timeSamples(i int) []float64 {
	times := []float64{0, 24, 25.3, 65, 69, Duration}
	for n := 288; n <= 828; n++ {
		times = append(times, float64(n)/12)
	}
	if i < 7 {
		start := captureStart(i)
		for frame := int(math.Floor(start * 60)); frame <= int(math.Ceil((revealTimes()[6]+3)*60)); frame++ {
			times = append(times, float64(frame)/60)
		}
		times = append(times, start, releaseTime(i), releaseTime(i)-.67, mouthTime(i), elbowTime(i), revealTimes()[i])
	}
	sort.Float64s(times)
	out := times[:0]
	for _, t := range times {
		if len(out) == 0 || t-out[len(out)-1] > .00001 {
			out = append(out, t)
		}
	}
	return out
}

func rounded(x float64) float64 { return math.Round(x*10000) / 10000 }
func key(t, x, y float64) map[string]any {
	return map[string]any{"time": rounded(t), "x": rounded(x), "y": rounded(y)}
}

// Build writes a NEW Spine4.3 scene. Geometry is shared across number bindings;
// each selected identity drives both its main and enlarged-view attachments.
func Build(directory, assets, shaders string, request Request, paced bool) (worker.Config, error) {
	if trackError != nil {
		return worker.Config{}, trackError
	}
	if err := request.Validate(); err != nil {
		return worker.Config{}, err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return worker.Config{}, err
	}
	if _, err := os.Stat(filepath.Join(directory, "scene.json")); !os.IsNotExist(err) {
		return worker.Config{}, errors.New("scene output already exists")
	}
	bones := []any{map[string]any{"name": "root"}}
	slots := []any{map[string]any{"name": "background", "bone": "root", "attachment": "background"}}
	attachments := map[string]any{"background": map[string]any{"background": map[string]any{"path": "background", "width": 1280, "height": 720}}}
	boneTracks, slotTracks, sequenceTracks := map[string]any{}, map[string]any{}, map[string]any{}
	bones = append(bones, map[string]any{"name": "pile_shadow", "parent": "root", "x": -22, "y": -136})
	slots = append(slots, map[string]any{"name": "pile_shadow", "bone": "pile_shadow", "attachment": "pile_shadow"})
	attachments["pile_shadow"] = map[string]any{"pile_shadow": map[string]any{"path": "pile-shadow", "width": 112, "height": 28}}
	slotTracks["pile_shadow"] = map[string]any{"alpha": []any{map[string]any{"time": 0, "value": 1}, map[string]any{"time": 24, "value": 1}, map[string]any{"time": 25.3, "value": 0}, map[string]any{"time": 65, "value": 0}, map[string]any{"time": 69, "value": 1}, map[string]any{"time": Duration, "value": 1}}}
	numbers := binding(request)
	for i, n := range numbers {
		name := fmt.Sprintf("main_%02d", i)
		bones = append(bones, map[string]any{"name": name, "parent": "root", "rotation": ballAngle(i)})
		slots = append(slots, map[string]any{"name": name, "bone": name, "attachment": name})
		attachments[name] = map[string]any{name: map[string]any{"path": fmt.Sprintf("balls/%02d-", n), "width": 19, "height": 19, "sequence": map[string]any{"count": 24, "start": 0, "digits": 2, "setup": 0}}}
		translate, scale, shades := []any{}, []any{}, []any{}
		for _, t := range timeSamples(i) {
			p := mainPosition(i, t)
			translate = append(translate, key(t, p.x-640, 360-p.y))
			factor := mainScale(i, t)
			scale = append(scale, key(t, factor, factor))
			shade := mainShade(i, t)
			opacity := .88
			if i < 7 {
				opacity = mix(.88, .96, dropProgress(i, t))
			}
			shades = append(shades, map[string]any{"time": rounded(t), "color": fmt.Sprintf("%02x%02x%02x%02x", int(shade*245), int(shade*250), int(shade*255), int(opacity*255))})
		}
		boneTracks[name] = map[string]any{"translate": translate, "scale": scale}
		if i < 7 {
			_, rotate := physicsKeys(i)
			boneTracks[name].(map[string]any)["rotate"] = rotate
		}
		slotTracks[name] = map[string]any{"rgba": shades}
		stop := 69.0
		if i < 7 {
			stop = SettledAt[i]
		}
		sequenceTracks[name] = map[string]any{name: map[string]any{"sequence": []any{map[string]any{"time": 0, "mode": "hold", "index": (i*7 + 3) % 24}, map[string]any{"time": 24, "mode": "loop", "index": i % 24, "delay": 1.0 / 24}, map[string]any{"time": stop, "mode": "hold", "index": settledFrame(i)}}}}
		if i < 7 {
			sequenceTracks[name] = map[string]any{name: map[string]any{"sequence": []any{map[string]any{"time": 0, "mode": "hold", "index": (i*7 + 3) % 24}, map[string]any{"time": 24, "mode": "loop", "index": i % 24, "delay": 1.0 / 24}, map[string]any{"time": releaseTime(i), "mode": "hold", "index": 0}}}}
		}
	}
	// Reuse the background UVs for foreground pipe walls/glass. This restores
	// occlusion without repainting the source plate or creating new bitmaps.
	for _, patch := range pipePatches() {
		slots = append(slots, map[string]any{"name": patch.name, "bone": "root", "attachment": patch.name, "color": patch.alpha})
		attachments[patch.name] = map[string]any{patch.name: pipeAttachment(patch)}
	}
	slots = append(slots, map[string]any{"name": "zoom_clip", "bone": "root", "attachment": "zoom_clip"})
	attachments["zoom_clip"] = map[string]any{"zoom_clip": magnifierFor(0).clip("zoom_5")}
	slots = append(slots, map[string]any{"name": "zoom_plate", "bone": "root", "attachment": "zoom_plate"})
	attachments["zoom_plate"] = map[string]any{"zoom_plate": magnifierFor(0).plate()}
	for i, n := range request.Numbers() {
		view := magnifierFor(i)
		if i == 6 {
			slots = append(slots, map[string]any{"name": "special_clip", "bone": "root", "attachment": "special_clip"})
			attachments["special_clip"] = map[string]any{"special_clip": view.clip("zoom_6")}
			slots = append(slots, map[string]any{"name": "special_plate", "bone": "root", "attachment": "special_plate"})
			attachments["special_plate"] = map[string]any{"special_plate": view.plate()}
		}
		name := fmt.Sprintf("zoom_%d", i)
		start := releaseTime(i)
		bones = append(bones, map[string]any{"name": name, "parent": "root", "rotation": ballAngle(i)})
		slots = append(slots, map[string]any{"name": name, "bone": name})
		master := fmt.Sprintf("main_%02d", i)
		attachments[name] = map[string]any{name: map[string]any{"path": fmt.Sprintf("balls/%02d-", n), "width": 19, "height": 19, "sequence": map[string]any{"count": 24, "start": 0, "digits": 2, "setup": 0}}}
		boneTracks[name] = magnifiedTracks(boneTracks[master].(map[string]any), view)
		slotTracks[name] = map[string]any{"rgba": slotTracks[master].(map[string]any)["rgba"], "attachment": []any{map[string]any{"time": 0, "name": nil}, map[string]any{"time": start, "name": name}}}
		sequenceTracks[name] = map[string]any{name: sequenceTracks[master].(map[string]any)[master]}
	}
	order := []any{}
	orderTimes := []float64{0}
	for f := 0; f <= 540; f++ {
		orderTimes = append(orderTimes, 24+float64(f)/12)
	}
	for _, t := range orderTimes {
		ids := make([]int, 49)
		for i := range ids {
			ids[i] = i
		}
		sort.SliceStable(ids, func(a, b int) bool { return mainPosition(ids[a], t).depth < mainPosition(ids[b], t).depth })
		destination := make([]int, 49)
		for at, i := range ids {
			destination[i] = at
		}
		offsets := []any{}
		for i := 0; i < 49; i++ {
			offsets = append(offsets, map[string]any{"slot": fmt.Sprintf("main_%02d", i), "offset": destination[i] - i})
		}
		order = append(order, map[string]any{"time": rounded(t), "offsets": offsets})
	}
	images, err := filepath.Rel(directory, filepath.Join(assets, "images"))
	if err != nil {
		return worker.Config{}, err
	}
	document := map[string]any{"skeleton": map[string]any{"spine": "4.3.23", "width": 1280, "height": 720, "x": -640, "y": -360, "images": filepath.ToSlash(images) + "/"}, "bones": bones, "slots": slots, "skins": []any{map[string]any{"name": "default", "attachments": attachments}}, "animations": map[string]any{"specified_result": map[string]any{"bones": boneTracks, "slots": slotTracks, "attachments": map[string]any{"default": sequenceTracks}, "drawOrder": order}}}
	encoded, err := json.Marshal(document)
	if err != nil {
		return worker.Config{}, err
	}
	if err = os.WriteFile(filepath.Join(directory, "scene.json"), encoded, 0600); err != nil {
		return worker.Config{}, err
	}
	c := worker.DefaultConfig()
	c.Skeleton = filepath.Join(directory, "scene.json")
	c.Atlas = filepath.Join(assets, "scene.atlas")
	c.Shaders = shaders
	c.Width = 1280
	c.Height = 720
	c.FPS = FPS
	c.Frames = int(Duration * FPS)
	c.Warmup = 0
	c.Paced = paced
	c.Loop = false
	c.Renderer = "vulkan"
	c.MSAA = 1
	c.PixelFormat = "nv12"
	c.QueueFrames = 2
	c.Animation = "specified_result"
	c.Verification = "full"
	x, y, s := 640.0, 360.0, 1.0
	c.X = &x
	c.Y = &y
	c.Scale = &s
	for i, n := range request.Numbers() {
		kind := "normal"
		if i == 6 {
			kind = "special"
		}
		file := filepath.Join(assets, "audio", fmt.Sprintf("%s-%02d.wav", kind, n))
		if _, err := os.Stat(file); err == nil {
			gain := .8
			c.Audio = append(c.Audio, worker.AudioTrack{File: file, OffsetMS: int(revealTimes()[i]*1000) + 120, Gain: &gain})
		}
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return c, err
	}
	err = os.WriteFile(filepath.Join(directory, "session.json"), data, 0600)
	if err == nil {
		poses := []any{}
		for i := 0; i < 7; i++ {
			p := trackMotion.At(i, Duration)
			branch := "left"
			if i == 6 {
				branch = "right-special-tray"
			}
			poses = append(poses, map[string]any{"number": request.Numbers()[i], "captureStart": captureStart(i), "mouthTime": mouthTime(i), "verticalPipeEnd": elbowTime(i), "topOutlet": releaseTime(i), "branch": branch, "release": releaseTime(i), "firstRest": trackMotion.Settled[i], "finalX": p.X, "finalY": p.Y, "finalAngleRadians": p.Angle})
		}
		audit, _ := json.MarshalIndent(map[string]any{"engine": "official Box2D", "version": "3.1.1", "commit": "8c661469c9507d3ad6fbd2fea3f1aa71669c2fe3", "stepHz": physicsStepHz, "substeps": physicsSubsteps, "sampleHz": 60, "samples": len(trackMotion.Samples), "coordinateSystem": "wide-camera pixels", "views": []any{magnifierFor(0).description(), magnifierFor(6).description()}, "scope": "one physical world for the visible wide-camera tracks; magnifiers uniformly transform the same serialized positions/scales/rotations/colours/sequences; central suction is guided airflow and chamber mixing is authored", "airliftModel": "position-continuous guided airflow, not a fluid simulation", "pipeForegroundOcclusion": true, "inlet": []float64{inletX, inletY}, "neck": []float64{inletX, neckY}, "balls": poses}, "", "  ")
		err = os.WriteFile(filepath.Join(directory, "physics.json"), audit, 0600)
	}
	return c, err
}
