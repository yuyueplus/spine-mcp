package broadcast

import (
	"math"
	"testing"
)

func TestEverySelectedBallUsesTheCentralMouthAndRiser(t *testing.T) {
	if trackError != nil {
		t.Fatal(trackError)
	}
	for i := 0; i < 7; i++ {
		gate := releaseTime(i)
		for time := captureStart(i); time < mouthTime(i); time += 1.0 / 120 {
			p := mainPosition(i, time)
			if p.y < inletY-.1 || math.Hypot(p.x-inletX, p.y-382) > 130 {
				t.Fatalf("ball%d did not approach the mouth from inside the lower chamber", i)
			}
		}
		mouth := mainPosition(i, mouthTime(i))
		if math.Hypot(mouth.x-inletX, mouth.y-inletY) > .001 {
			t.Fatalf("ball%d bypassed the inlet", i)
		}
		crossedNeck := false
		lastY := inletY + .1
		for n := 0; n <= 240; n++ {
			time := mix(mouthTime(i), elbowTime(i), float64(n)/240)
			p := mainPosition(i, time)
			if math.Abs(p.x-inletX) > .001 || p.y > lastY+.00001 {
				t.Fatalf("ball%d escaped or reversed inside the vertical pipe", i)
			}
			if p.y <= neckY {
				crossedNeck = true
			}
			lastY = p.y
		}
		if !crossedNeck {
			t.Fatal("ball never crossed the narrow inlet neck")
		}
		for _, time := range []float64{captureStart(i), gate - .67, mouthTime(i), elbowTime(i), gate} {
			p, q := mainPosition(i, time-.0001), mainPosition(i, time+.0001)
			if math.Hypot(p.x-q.x, p.y-q.y) > .3 {
				t.Fatalf("ball%d teleported at transfer boundary %.4f", i, time)
			}
		}
		port := mainPosition(i, gate)
		physical := trackMotion.At(i, gate)
		if math.Hypot(port.x-physical.X, port.y-physical.Y) > .001 || port.y < 240 || port.y > 243 || math.Abs(math.Abs(port.x-inletX)-15) > .1 {
			t.Fatal("top outlet is disconnected from the result track")
		}
		for n := 0; n < 120; n++ {
			time := gate + float64(n)/120
			p := mainPosition(i, time)
			if math.Pow((p.x-618)/141, 2)+math.Pow((p.y-397)/146, 2) < 1 {
				t.Fatalf("ball%d shortcut through the globe after the top outlet", i)
			}
		}
	}
}

func TestMixingStaysBelowTheIntakeAndPipeUVsMatchThePlate(t *testing.T) {
	for i := 0; i < 49; i++ {
		for n := 0; n < 360; n++ {
			p := stirring(i, 24+float64(n)/12)
			if p.y < 408.9 {
				t.Fatal("ordinary mixing ball entered the upper pipe area")
			}
		}
	}
	for _, patch := range pipePatches() {
		attachment := pipeAttachment(patch)
		uvs := attachment["uvs"].([]float64)
		for _, value := range uvs {
			if value < 0 || value > 1 {
				t.Fatal("pipe occlusion samples outside the background")
			}
		}
		if attachment["path"] != "background" {
			t.Fatal("pipe overlay no longer uses the unchanged plate")
		}
	}
}
