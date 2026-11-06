package broadcast

import "math"

// The vacuum transfer uses a constrained, C1-continuous airflow path. The
// subsequent enlarged result channel is still simulated by Box2D. No fluid
// simulation or main-chamber rigid-body simulation is claimed here.
const inletX = 618.0
const inletY = 400.0
const neckY = 367.0

func captureStart(i int) float64 { return releaseTime(i) - 1.10 }
func mouthTime(i int) float64    { return releaseTime(i) - .42 }
func elbowTime(i int) float64    { return releaseTime(i) - .12 }

func hermitePoint(a, b, va, vb point, u, duration float64) point {
	u = clamp(u, 0, 1)
	u2, u3 := u*u, u*u*u
	h00, h10, h01, h11 := 2*u3-3*u2+1, u3-2*u2+u, -2*u3+3*u2, u3-u2
	return point{h00*a.x + h10*duration*va.x + h01*b.x + h11*duration*vb.x,
		h00*a.y + h10*duration*va.y + h01*b.y + h11*duration*vb.y, 1}
}

func airliftPosition(i int, t float64) point {
	gate := releaseTime(i)
	port := trackMotion.At(i, gate)
	elbowRadius := math.Abs(port.X - inletX)
	elbowY := port.Y + elbowRadius
	begin := captureStart(i)
	p := chamber(i, begin)
	previous, next := chamber(i, begin-.001), chamber(i, begin+.001)
	v := point{(next.x - previous.x) / .002, (next.y - previous.y) / .002, 1}
	side := 1.0
	if p.x < inletX {
		side = -1
	}
	stage := gate - .67
	approach := point{inletX + side*28, 435, 1}
	approachVelocity := point{-side * 120, 0, 1}
	if t < stage {
		return hermitePoint(p, approach, v, approachVelocity, (t-begin)/(stage-begin), stage-begin)
	}
	if t < mouthTime(i) {
		return hermitePoint(approach, point{inletX, inletY, 1}, approachVelocity, point{0, -520, 1}, (t-stage)/(mouthTime(i)-stage), mouthTime(i)-stage)
	}
	if t < elbowTime(i) {
		return hermitePoint(point{inletX, inletY, 1}, point{inletX, elbowY, 1}, point{0, -520, 1}, point{0, -math.Pi * elbowRadius / (2 * .12), 1}, (t-mouthTime(i))/(elbowTime(i)-mouthTime(i)), elbowTime(i)-mouthTime(i))
	}
	// Match the physical entry tangent and speed, so the lower outlet and
	// rolling channel meet without a spatial or velocity discontinuity.
	return hermitePoint(point{inletX, elbowY, 1}, point{port.X, port.Y, 1},
		point{0, -math.Pi * elbowRadius / (2 * .12), 1}, point{port.VX, port.VY, 1},
		(t-elbowTime(i))/.12, .12)
}

// The physical world uses the wide camera coordinates directly.
func outerTrackPosition(i int, t float64) point {
	p := trackMotion.At(i, t)
	return point{p.X, p.Y, 1}
}

type foregroundPatch struct {
	name     string
	vertices []point
	alpha    string
}

func pipePatches() []foregroundPatch {
	quad := func(name string, x0, y0, x1, y1 float64, alpha string) foregroundPatch {
		return foregroundPatch{name, []point{{x0, y0, 0}, {x1, y0, 0}, {x1, y1, 0}, {x0, y1, 0}}, alpha}
	}
	return []foregroundPatch{
		quad("pipe_glass", 610, 246, 628, 367, "ffffff48"),
		{"funnel_glass", []point{{606, 367, 0}, {631, 367, 0}, {651, 400, 0}, {586, 400, 0}}, "ffffff58"},
		quad("pipe_left_wall", 604, 245, 610, 367, "ffffffff"),
		quad("pipe_right_wall", 628, 245, 633, 367, "ffffffff"),
		quad("funnel_front_lip", 586, 398, 652, 401, "ffffffff"),
		quad("top_outlet_cover", 585, 219, 651, 245, "ffffffff"),
	}
}

func pipeAttachment(p foregroundPatch) map[string]any {
	vertices, uvs := []float64{}, []float64{}
	for _, v := range p.vertices {
		vertices = append(vertices, v.x-640, 360-v.y)
		uvs = append(uvs, v.x/1280, v.y/720)
	}
	return map[string]any{"type": "mesh", "path": "background", "uvs": uvs, "vertices": vertices, "triangles": []int{0, 1, 2, 2, 3, 0}, "hull": 4}
}
