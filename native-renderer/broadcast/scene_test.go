package broadcast

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func referenceRequest() Request {
	return Request{Mode: "scripted_demo", RoundID: "demo-001", RequestID: "request-0001", RegularNumbers: []int{40, 48, 10, 20, 27, 11}, SpecialNumber: 4}
}

func TestRequestRejectsInvalidAndAmbiguousResults(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Request)
	}{
		{"mode", func(r *Request) { r.Mode = "live" }},
		{"path", func(r *Request) { r.RoundID = "../escape" }},
		{"short-request-id", func(r *Request) { r.RequestID = "short" }},
		{"count", func(r *Request) { r.RegularNumbers = r.RegularNumbers[:5] }},
		{"zero", func(r *Request) { r.RegularNumbers[0] = 0 }},
		{"above-49", func(r *Request) { r.SpecialNumber = 50 }},
		{"duplicate-regular", func(r *Request) { r.RegularNumbers[0] = 48 }},
		{"duplicate-special", func(r *Request) { r.SpecialNumber = 40 }},
	}
	if e := referenceRequest().Validate(); e != nil {
		t.Fatal(e)
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			r := referenceRequest()
			test.edit(&r)
			if r.Validate() == nil {
				t.Fatal("invalid request accepted")
			}
		})
	}
}

func TestPaletteCoversAllIdentitiesExactlyOnce(t *testing.T) {
	seen := map[int]bool{}
	for color, numbers := range colorSets {
		for _, n := range numbers {
			if seen[n] || n < 1 || n > 49 || Color(n) != color {
				t.Fatalf("invalid or duplicate palette identity %d", n)
			}
			seen[n] = true
		}
	}
	if len(seen) != 49 || Color(49) != "green" || Color(0) != "" {
		t.Fatal("palette does not cover the verified1..49 rule")
	}
}

func TestScenePreservesSpecifiedIdentityInBothViews(t *testing.T) {
	for _, special := range []int{4, 49} {
		t.Run(fmt.Sprint(special), func(t *testing.T) {
			r := referenceRequest()
			r.SpecialNumber = special
			base := t.TempDir()
			assets := filepath.Join(base, "assets")
			if e := os.MkdirAll(filepath.Join(assets, "audio"), 0700); e != nil {
				t.Fatal(e)
			}
			for i, n := range r.Numbers() {
				kind := "normal"
				if i == 6 {
					kind = "special"
				}
				if e := os.WriteFile(filepath.Join(assets, "audio", fmt.Sprintf("%s-%02d.wav", kind, n)), []byte("fixture"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			dir := filepath.Join(base, "new-output")
			config, e := Build(dir, assets, "shaders", r, true)
			if e != nil {
				t.Fatal(e)
			}
			if config.Frames != 3510 || !config.Paced || config.Loop || len(config.Audio) != 7 {
				t.Fatal("finite scene or audio contract changed")
			}
			for i, a := range config.Audio {
				if a.OffsetMS != int(revealTimes()[i]*1000)+120 {
					t.Fatal("callout timing changed")
				}
			}
			var scene struct {
				Skins []struct {
					Attachments map[string]map[string]struct {
						Path string `json:"path"`
					} `json:"attachments"`
				} `json:"skins"`
				Animations map[string]struct {
					Bones map[string]struct {
						Translate []struct{ Time, X, Y float64 } `json:"translate"`
					} `json:"bones"`
					DrawOrder []struct {
						Time    float64 `json:"time"`
						Offsets []struct {
							Slot   string `json:"slot"`
							Offset int    `json:"offset"`
						} `json:"offsets"`
					} `json:"drawOrder"`
				} `json:"animations"`
			}
			data, e := os.ReadFile(config.Skeleton)
			if e != nil || json.Unmarshal(data, &scene) != nil {
				t.Fatal("scene could not be decoded")
			}
			order := scene.Animations["specified_result"].DrawOrder
			if len(order) == 0 || order[0].Time != 0 || len(order[0].Offsets) != 49 {
				t.Fatal("resting-pile occlusion is missing at the beginning")
			}
			depths := make([]float64, 49)
			occupied := map[int]bool{}
			for _, offset := range order[0].Offsets {
				var index int
				if _, e := fmt.Sscanf(offset.Slot, "main_%02d", &index); e != nil {
					t.Fatal(e)
				}
				at := index + offset.Offset
				if at < 0 || at >= 49 || occupied[at] {
					t.Fatal("invalid ball draw-order permutation")
				}
				occupied[at] = true
				depths[at] = pile(index).depth
			}
			for i := 1; i < len(depths); i++ {
				if depths[i] < depths[i-1] {
					t.Fatal("back ball is drawn over a front ball in the resting pile")
				}
			}
			seen := map[string]bool{}
			for i := 0; i < 49; i++ {
				name := fmt.Sprintf("main_%02d", i)
				p := scene.Skins[0].Attachments[name][name].Path
				if p == "" || seen[p] {
					t.Fatal("missing or duplicated physical ball identity")
				}
				seen[p] = true
				if i < 7 {
					zoom := fmt.Sprintf("zoom_%d", i)
					if p != fmt.Sprintf("balls/%02d-", r.Numbers()[i]) || scene.Skins[0].Attachments[zoom][zoom].Path != p {
						t.Fatalf("specified result %d disagrees between views", i)
					}
				}
				last := -1.0
				for _, frame := range scene.Animations["specified_result"].Bones[name].Translate {
					if frame.Time <= last || math.IsNaN(frame.X) || math.IsNaN(frame.Y) {
						t.Fatal("invalid position timeline")
					}
					last = frame.Time
				}
			}
			before := append([]byte(nil), data...)
			if _, e = Build(dir, assets, "shaders", r, true); e == nil {
				t.Fatal("existing scene overwritten")
			}
			after, _ := os.ReadFile(config.Skeleton)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("failed rebuild changed the existing scene")
			}
		})
	}
}

func TestBallPathsStayInChamberUntilReleasedAndSettle(t *testing.T) {
	for i := 0; i < 49; i++ {
		for f := 0; f < 69*30; f++ {
			time := float64(f) / 30
			if i < 7 && time >= captureStart(i) {
				continue
			}
			p := mainPosition(i, time)
			if math.Hypot(p.x-618, p.y-382) > 120.00001 {
				t.Fatalf("ball %d escaped the chamber at%f", i, time)
			}
		}
		if i < 7 {
			p, z := mainPosition(i, Duration), zoomPosition(i, Duration)
			inverse := magnifierFor(i).inverse(z)
			if math.Hypot(p.x-rack[i].x, p.y-rack[i].y) > 5 || math.Hypot(inverse.x-p.x, inverse.y-p.y) > 1e-9 {
				t.Fatal("final result position drifted")
			}
		}
	}
	if Revealed(35.999) != 0 || Revealed(36) != 1 || Revealed(revealTimes()[6]) != 7 {
		t.Fatal("reveal boundaries changed")
	}
}
