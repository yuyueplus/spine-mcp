package broadcast

import (
	"fmt"
	"math"

	"github.com/yuyueplus/spine-mcp/native-renderer/internal/trackphysics"
)

var trackMotion, trackError = bakeTrack()

const physicsStepHz = trackphysics.StepHz
const physicsSubsteps = trackphysics.Substeps

func bakeTrack() (trackphysics.Motion, error) {
	var releases, angles [7]float64
	for i := range releases {
		releases[i] = SettledAt[i] - 1.4
		angles[i] = ballAngle(i) * math.Pi / 180
	}
	releases[6] = 63.9
	// Calibrate the gates to the programme's reveal times. Positions and angles
	// are never fitted to a curve or overwritten when a ball lands.
	for pass := 0; pass < 3; pass++ {
		motion, err := trackphysics.Bake(releases, angles, Duration)
		if err != nil {
			return motion, err
		}
		matched := true
		for i, time := range motion.Settled {
			if time < 0 {
				return motion, fmt.Errorf("track ball %d did not settle", i)
			}
			if i == 6 {
				if time > 69 {
					return motion, fmt.Errorf("special ball did not settle before result hold")
				}
				continue
			}
			delta := SettledAt[i] - time
			if math.Abs(delta) > .02 {
				matched = false
			}
			releases[i] += delta
		}
		if matched {
			return motion, nil
		}
	}
	return trackphysics.Motion{}, fmt.Errorf("physical track did not meet the programme's settling windows")
}

func revealTimes() []float64 {
	times := append([]float64(nil), SettledAt...)
	if trackError == nil {
		times[6] = trackMotion.Settled[6]
	}
	return times
}

func releaseTime(i int) float64 { return trackMotion.Releases[i] }

func dropProgress(i int, time float64) float64 {
	start := trackMotion.At(i, releaseTime(i))
	end := trackMotion.At(i, Duration)
	p := trackMotion.At(i, time)
	return clamp((p.Y-start.Y)/(end.Y-start.Y), 0, 1)
}

func physicsKeys(i int) (translate, rotate []any) {
	p := trackMotion.At(i, 0)
	translate = append(translate, key(0, p.X-640, 360-p.Y))
	rotate = append(rotate, map[string]any{"time": 0, "value": 0})
	first := int(math.Floor(releaseTime(i) * trackphysics.FPS))
	// The six-ball stack remains dynamic while subsequent balls arrive.
	// Keep poses through the last landing, then hold the sleeping bodies.
	last := int(math.Min(Duration, revealTimes()[6]+3) * trackphysics.FPS)
	for frame := first; frame <= last; frame++ {
		t := float64(frame) / trackphysics.FPS
		p = trackMotion.At(i, t)
		translate = append(translate, key(t, p.X-640, 360-p.Y))
		rotate = append(rotate, map[string]any{"time": rounded(t), "value": rounded(p.Angle*180/math.Pi - ballAngle(i))})
	}
	p = trackMotion.At(i, Duration)
	translate = append(translate, key(Duration, p.X-640, 360-p.Y))
	rotate = append(rotate, map[string]any{"time": Duration, "value": rounded(p.Angle*180/math.Pi - ballAngle(i))})
	return
}
