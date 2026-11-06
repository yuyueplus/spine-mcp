// Package trackphysics bakes numbered-ball track motion using pinned official
// Box2D3.1.1. Only immutable sampled poses cross the C/Go boundary.
package trackphysics

/*
#cgo CFLAGS: -std=c17 -DBOX2D_DISABLE_SIMD -I${SRCDIR}/box2d/include -I${SRCDIR}/box2d/src
#cgo LDFLAGS: -lm
#include <stdlib.h>
#include "track.h"
*/
import "C"

import (
	"errors"
	"math"
	"sync"
	"unsafe"
)

const FPS = 60
const StepHz = 120
const Substeps = 16

var bakeMutex sync.Mutex

type Pose struct {
	X, Y, Angle, VX, VY, Omega float64
	Visible                    bool
}
type Motion struct {
	Samples           [][7]Pose
	Releases, Settled [7]float64
}

func Bake(releases, angles [7]float64, duration float64) (Motion, error) {
	bakeMutex.Lock()
	defer bakeMutex.Unlock()
	var m Motion
	if duration <= 0 || duration > 120 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return m, errors.New("invalid physics bake duration")
	}
	frames := int(math.Round(duration*FPS)) + 1
	var r, a [7]C.double
	for i := range r {
		if releases[i] < 0 || releases[i] >= duration || math.IsNaN(releases[i]) || math.IsNaN(angles[i]) || math.IsInf(releases[i], 0) || math.IsInf(angles[i], 0) {
			return m, errors.New("invalid physics release")
		}
		r[i] = C.double(releases[i])
		a[i] = C.double(angles[i])
	}
	bytes := C.size_t(frames*7) * C.size_t(C.sizeof_TrackSample)
	memory := C.malloc(bytes)
	if memory == nil {
		return m, errors.New("physics sample allocation failed")
	}
	defer C.free(memory)
	var settled [7]C.double
	if C.track_bake(&r[0], &a[0], C.int(frames), (*C.TrackSample)(memory), &settled[0]) != 0 {
		return m, errors.New("Box2D bake failed")
	}
	samples := unsafe.Slice((*C.TrackSample)(memory), frames*7)
	m.Samples = make([][7]Pose, frames)
	m.Releases = releases
	for i := range settled {
		m.Settled[i] = float64(settled[i])
	}
	for f := range m.Samples {
		for i := 0; i < 7; i++ {
			s := samples[f*7+i]
			m.Samples[f][i] = Pose{float64(s.x), float64(s.y), float64(s.angle), float64(s.vx), float64(s.vy), float64(s.omega), s.visible != 0}
		}
	}
	return m, nil
}

func (m *Motion) At(i int, time float64) Pose {
	// Interpolate from the exact birth event when a gate opens between frames.
	if time <= m.Releases[i] {
		p := m.Samples[0][i]
		p.Visible = time >= m.Releases[i]
		return p
	}
	first := int(math.Ceil(m.Releases[i]*FPS - 1e-7))
	if first < len(m.Samples) && time < float64(first)/FPS {
		p, q := m.Samples[0][i], m.Samples[first][i]
		u := (time - m.Releases[i]) / (float64(first)/FPS - m.Releases[i])
		return Pose{p.X + (q.X-p.X)*u, p.Y + (q.Y-p.Y)*u, p.Angle + (q.Angle-p.Angle)*u, q.VX, q.VY, q.Omega, true}
	}
	t := math.Max(0, math.Min(float64(len(m.Samples)-1), time*FPS))
	a := int(t)
	b := a + 1
	if b >= len(m.Samples) {
		return m.Samples[a][i]
	}
	u := t - float64(a)
	p, q := m.Samples[a][i], m.Samples[b][i]
	return Pose{p.X + (q.X-p.X)*u, p.Y + (q.Y-p.Y)*u, p.Angle + (q.Angle-p.Angle)*u, p.VX + (q.VX-p.VX)*u, p.VY + (q.VY-p.VY)*u, p.Omega + (q.Omega-p.Omega)*u, p.Visible}
}
