package trackphysics

import (
	"math"
	"testing"
)

func TestTrackBake(t *testing.T) {
	r := [7]float64{34.6, 39.6, 43.6, 48.6, 53.6, 57.6, 62.6}
	m, e := Bake(r, [7]float64{}, 117)
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 7; i++ {
		p := m.At(i, 117)
		t.Logf("%d settled %.3f final %.2f %.2f speed %.3f omega %.3f", i, m.Settled[i], p.X, p.Y, p.VX*p.VX+p.VY*p.VY, p.Omega)
		if m.Settled[i] < r[i] || m.Settled[i] > 69 || p.VX*p.VX+p.VY*p.VY > .01 || math.Abs(p.Omega) > .001 {
			t.Fatal("body did not stop physically")
		}
		if i < 6 && (p.X < 460 || p.X > 495 || p.Y < 310 || p.Y > 422) {
			t.Fatal("regular ball escaped its channel")
		}
		if i == 6 && (p.X < 755 || p.X > 785 || p.Y < 400 || p.Y > 427) {
			t.Fatal("special ball missed its tray")
		}
	}
	rolls := 0
	nearest, worstFrame, worstA, worstB := math.Inf(1), 0, 0, 0
	for f, poses := range m.Samples {
		for i, p := range poses {
			if !p.Visible {
				continue
			}
			if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) {
				t.Fatal("non-finite simulation")
			}
			if i < 6 && p.Y > m.At(i, 117).Y+2 {
				t.Fatal("ball passed through its final stack contact")
			}
			if math.Abs(p.Omega) > .1 {
				rolls++
			}
			if f > 0 && m.Samples[f-1][i].Visible {
				q := m.Samples[f-1][i]
				if math.Hypot(p.X-q.X, p.Y-q.Y) > 25 {
					t.Fatal("discontinuous pose")
				}
			}
			if i < 6 {
				for j := i + 1; j < 6; j++ {
					q := poses[j]
					if q.Visible && math.Hypot(p.X-q.X, p.Y-q.Y) < nearest {
						nearest, worstFrame, worstA, worstB = math.Hypot(p.X-q.X, p.Y-q.Y), f, i, j
					}
				}
			}
		}
	}
	if rolls < 20 {
		t.Fatal("no contact-driven rotation")
	}
	// Bound transient SoftStep compression to half a wide-camera pixel.
	t.Logf("nearest contact %.5f, worst frame %d balls%d/%d", nearest, worstFrame, worstA, worstB)
	if nearest < 19.3 {
		t.Fatalf("transient contact compression exceeded0.5 pixels: %.5f", 19.8-nearest)
	}
}

func TestBallsStayAgainstVisibleLowerLip(t *testing.T) {
	m, e := Bake([7]float64{34.6, 39.6, 43.6, 48.6, 53.6, 57.6, 62.6}, [7]float64{}, 117)
	if e != nil {
		t.Fatal(e)
	}
	// Photo-calibrated lower lip, independent of the channel's interpolated
	// centerline. Measure every sampled center against the visible support.
	maxGap, checked := 0.0, 0
	for _, poses := range m.Samples {
		for i, p := range poses {
			if !p.Visible || p.Y > 350 {
				continue
			}
			direction := -1.0
			if i == 6 {
				direction = 1
			}
			distance := math.Inf(1)
			for n := 0; n <= 1000; n++ {
				a := math.Asin(14.0/141) + (1.4-math.Asin(14.0/141))*float64(n)/1000
				x, y := 618+direction*141*math.Sin(a), 397-146*math.Cos(a)
				distance = math.Min(distance, math.Hypot(p.X-x, p.Y-y))
			}
			gap := distance - 9.9 - .3
			maxGap = math.Max(maxGap, gap)
			checked++
			if gap < -.4 || gap > 1.4 {
				t.Fatalf("ball%d is not supported by the visible lower lip: gap %.4fpx at %.2f,%.2f", i, gap, p.X, p.Y)
			}
		}
	}
	if checked < 300 {
		t.Fatal("insufficient upper-channel contact samples")
	}
	t.Logf("%d upper-channel poses; maximum lower-lip clearance %.4f wide-camera pixels", checked, maxGap)
}
