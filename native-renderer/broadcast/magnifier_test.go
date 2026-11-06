package broadcast

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

type viewKey struct{ Time, X, Y, Value float64 }
type viewTrack struct{ Translate, Scale, Rotate []viewKey }

func sampleView(keys []viewKey, time float64) viewKey {
	at := sort.Search(len(keys), func(i int) bool { return keys[i].Time > time }) - 1
	if at < 0 {
		return keys[0]
	}
	if at == len(keys)-1 {
		return keys[at]
	}
	a, b := keys[at], keys[at+1]
	u := (time - a.Time) / (b.Time - a.Time)
	return viewKey{Time: time, X: mix(a.X, b.X, u), Y: mix(a.Y, b.Y, u), Value: mix(a.Value, b.Value, u)}
}

func TestSerializedViewsMatchAtEveryVideoFrame(t *testing.T) {
	dir := t.TempDir()
	config, e := Build(filepath.Join(dir, "scene"), filepath.Join(dir, "assets"), "shaders", referenceRequest(), false)
	if e != nil {
		t.Fatal(e)
	}
	bytes, e := os.ReadFile(config.Skeleton)
	if e != nil {
		t.Fatal(e)
	}
	var scene struct {
		Animations map[string]struct {
			Bones       map[string]viewTrack
			Slots       map[string]json.RawMessage
			Attachments map[string]map[string]map[string]json.RawMessage
		}
	}
	if e = json.Unmarshal(bytes, &scene); e != nil {
		t.Fatal(e)
	}
	anim := scene.Animations["specified_result"]
	for i := 0; i < 7; i++ {
		mainName, zoomName := fmt.Sprintf("main_%02d", i), fmt.Sprintf("zoom_%d", i)
		a, b := anim.Bones[mainName], anim.Bones[zoomName]
		view := magnifierFor(i)
		if len(a.Translate) != len(b.Translate) || len(a.Scale) != len(b.Scale) || !reflect.DeepEqual(a.Rotate, b.Rotate) {
			t.Fatal("view timelines are independent")
		}
		for k := range a.Translate {
			if a.Translate[k].Time != b.Translate[k].Time {
				t.Fatal("view key times differ")
			}
		}
		var mainSlot, zoomSlot map[string]json.RawMessage
		_ = json.Unmarshal(anim.Slots[mainName], &mainSlot)
		_ = json.Unmarshal(anim.Slots[zoomName], &zoomSlot)
		if string(mainSlot["rgba"]) != string(zoomSlot["rgba"]) {
			t.Fatal("same ball has different colours/opacity")
		}
		if string(anim.Attachments["default"][mainName][mainName]) != string(anim.Attachments["default"][zoomName][zoomName]) {
			t.Fatal("same ball has different texture sequence")
		}
		for frame := 0; frame < int(Duration*FPS); frame++ {
			time := float64(frame) / FPS
			p, q := sampleView(a.Translate, time), sampleView(b.Translate, time)
			inverse := view.inverse(point{q.X + 640, 360 - q.Y, 0})
			if math.Hypot(inverse.x-(p.X+640), inverse.y-(360-p.Y)) > 1e-8 {
				t.Fatalf("ball%d frame%d positions disagree", i, frame)
			}
			sa, sb := sampleView(a.Scale, time), sampleView(b.Scale, time)
			if math.Abs(sa.X-sb.X/view.Scale) > 1e-10 || math.Abs(sa.Y-sb.Y/view.Scale) > 1e-10 {
				t.Fatal("ball radius differs between views")
			}
			if math.Abs(sampleView(a.Rotate, time).Value-sampleView(b.Rotate, time).Value) > 1e-10 {
				t.Fatal("ball rotation differs between views")
			}
		}
	}
}

func TestMagnifierSourceRegionsExcludeOtherObjects(t *testing.T) {
	for i := 7; i < 49; i++ {
		for frame := 0; frame < 69*FPS; frame++ {
			time := float64(frame) / FPS
			p := mainPosition(i, time)
			r := 19 * mainScale(i, time) / 2
			for _, view := range []magnifier{magnifierFor(0), magnifierFor(6)} {
				right, bottom := view.SourceX+view.Width/view.Scale, view.SourceY+view.Height/view.Scale
				if p.x+r >= view.SourceX && p.x-r <= right && p.y+r >= view.SourceY && p.y-r <= bottom {
					t.Fatal("uncloned chamber object can enter a magnifier crop")
				}
			}
		}
	}
}
