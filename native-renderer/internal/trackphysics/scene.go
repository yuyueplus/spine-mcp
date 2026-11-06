package trackphysics

/*
#include <stdlib.h>
#include "track.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"math"
	"unsafe"
)

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type SceneBody struct {
	ID              string  `json:"id"`
	Position        Point   `json:"position"`
	Velocity        Point   `json:"velocity"`
	Rotation        float64 `json:"rotation"`
	AngularVelocity float64 `json:"angularVelocity"`
	Radius          float64 `json:"radius"`
	Density         float64 `json:"density"`
	Friction        float64 `json:"friction"`
	Restitution     float64 `json:"restitution"`
	LinearDamping   float64 `json:"linearDamping"`
	AngularDamping  float64 `json:"angularDamping"`
	Spawn           float64 `json:"spawn"`
	Category        uint32  `json:"category"`
	Mask            uint32  `json:"mask"`
}
type SceneRail struct {
	Points      []Point `json:"points"`
	Radius      float64 `json:"radius"`
	Friction    float64 `json:"friction"`
	Restitution float64 `json:"restitution"`
	Category    uint32  `json:"category"`
	Mask        uint32  `json:"mask"`
}
type Scene struct {
	Duration      float64     `json:"duration"`
	FPS           int         `json:"fps"`
	StepHz        int         `json:"stepHz"`
	Substeps      int         `json:"substeps"`
	UnitsPerMeter float64     `json:"unitsPerMeter"`
	Gravity       Point       `json:"gravity"`
	Bodies        []SceneBody `json:"bodies"`
	Rails         []SceneRail `json:"rails"`
}
type ScenePose struct {
	X               float64 `json:"x"`
	Y               float64 `json:"y"`
	Rotation        float64 `json:"rotation"`
	VX              float64 `json:"vx"`
	VY              float64 `json:"vy"`
	AngularVelocity float64 `json:"angularVelocity"`
	Visible         bool    `json:"visible"`
}
type SceneFrame struct {
	Time  float64     `json:"time"`
	Poses []ScenePose `json:"poses"`
}
type SceneResult struct {
	Engine  string       `json:"engine"`
	Version string       `json:"version"`
	BodyIDs []string     `json:"bodyIds"`
	Frames  []SceneFrame `json:"frames"`
}

func (s Scene) Validate() error {
	finite := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) <= 1e6 }
	if !finite(s.Duration) || s.Duration <= 0 || s.Duration > 120 || s.FPS < 1 || s.FPS > 120 || s.StepHz < s.FPS || s.StepHz > 480 || s.StepHz%s.FPS != 0 || s.Substeps < 1 || s.Substeps > 32 || !finite(s.UnitsPerMeter) || s.UnitsPerMeter < 1 || s.UnitsPerMeter > 10000 {
		return errors.New("invalid simulation duration, timestep or scale")
	}
	if len(s.Bodies) < 1 || len(s.Bodies) > 128 || int(math.Ceil(s.Duration*float64(s.FPS))+1)*len(s.Bodies) > 250000 {
		return errors.New("simulation exceeds body/pose budget")
	}
	if !finite(s.Gravity.X) || !finite(s.Gravity.Y) {
		return errors.New("invalid gravity")
	}
	seen := map[string]bool{}
	for _, b := range s.Bodies {
		if b.ID == "" || len(b.ID) > 200 || seen[b.ID] {
			return errors.New("body IDs must be unique")
		}
		seen[b.ID] = true
		for _, v := range []float64{b.Position.X, b.Position.Y, b.Velocity.X, b.Velocity.Y, b.Rotation, b.AngularVelocity, b.Radius, b.Density, b.Friction, b.Restitution, b.LinearDamping, b.AngularDamping, b.Spawn} {
			if !finite(v) {
				return errors.New("non-finite body")
			}
		}
		if b.Radius <= 0 || b.Radius > 10000 || b.Density <= 0 || b.Density > 10000 || b.Friction < 0 || b.Friction > 10 || b.Restitution < 0 || b.Restitution > 1 || b.LinearDamping < 0 || b.AngularDamping < 0 || b.Spawn < 0 || b.Spawn >= s.Duration || b.Category == 0 || b.Mask == 0 {
			return errors.New("invalid body material, spawn or collision filter")
		}
	}
	segments := 0
	for _, r := range s.Rails {
		if len(r.Points) < 2 || len(r.Points) > 512 || !finite(r.Radius) || r.Radius <= 0 || r.Radius > 1000 || !finite(r.Friction) || r.Friction < 0 || r.Friction > 10 || !finite(r.Restitution) || r.Restitution < 0 || r.Restitution > 1 || r.Category == 0 || r.Mask == 0 {
			return errors.New("invalid rail")
		}
		for i, p := range r.Points {
			if !finite(p.X) || !finite(p.Y) {
				return errors.New("invalid rail point")
			}
			if i > 0 && math.Hypot(p.X-r.Points[i-1].X, p.Y-r.Points[i-1].Y) < .001 {
				return errors.New("zero-length rail segment")
			}
		}
		segments += len(r.Points) - 1
	}
	if segments > 2048 {
		return errors.New("rail segment budget exceeded")
	}
	return nil
}

func BakeScene(s Scene) (SceneResult, error) {
	var result SceneResult
	if e := s.Validate(); e != nil {
		return result, e
	}
	bakeMutex.Lock()
	defer bakeMutex.Unlock()
	bodies := make([]C.PhysicsBody, len(s.Bodies))
	segments := []C.PhysicsSegment{}
	for i, b := range s.Bodies {
		bodies[i] = C.PhysicsBody{x: C.float(b.Position.X), y: C.float(b.Position.Y), angle: C.float(b.Rotation * math.Pi / 180), vx: C.float(b.Velocity.X), vy: C.float(b.Velocity.Y), omega: C.float(b.AngularVelocity * math.Pi / 180), radius: C.float(b.Radius), density: C.float(b.Density), friction: C.float(b.Friction), restitution: C.float(b.Restitution), linear_damping: C.float(b.LinearDamping), angular_damping: C.float(b.AngularDamping), spawn: C.float(b.Spawn), category: C.uint(b.Category), mask: C.uint(b.Mask)}
		result.BodyIDs = append(result.BodyIDs, b.ID)
	}
	for _, r := range s.Rails {
		for i := 1; i < len(r.Points); i++ {
			a, b := r.Points[i-1], r.Points[i]
			segments = append(segments, C.PhysicsSegment{ax: C.float(a.X), ay: C.float(a.Y), bx: C.float(b.X), by: C.float(b.Y), radius: C.float(r.Radius), friction: C.float(r.Friction), restitution: C.float(r.Restitution), category: C.uint(r.Category), mask: C.uint(r.Mask)})
		}
	}
	frames := int(math.Ceil(s.Duration*float64(s.FPS))) + 1
	memory := C.malloc(C.size_t(frames*len(bodies)) * C.size_t(C.sizeof_TrackSample))
	if memory == nil {
		return result, errors.New("simulation allocation failed")
	}
	defer C.free(memory)
	var rails *C.PhysicsSegment
	if len(segments) > 0 {
		rails = &segments[0]
	}
	if C.physics_bake(&bodies[0], C.int(len(bodies)), rails, C.int(len(segments)), C.float(s.Gravity.X), C.float(s.Gravity.Y), C.float(s.UnitsPerMeter), C.int(s.FPS), C.int(s.StepHz), C.int(s.Substeps), C.int(frames), (*C.TrackSample)(memory)) != 0 {
		return result, errors.New("simulation failed")
	}
	raw := unsafe.Slice((*C.TrackSample)(memory), frames*len(bodies))
	result.Engine = "official Box2D"
	result.Version = "3.1.1"
	for f := 0; f < frames; f++ {
		frame := SceneFrame{Time: float64(f) / float64(s.FPS)}
		for i := range bodies {
			p := raw[f*len(bodies)+i]
			v := ScenePose{float64(p.x), float64(p.y), float64(p.angle) * 180 / math.Pi, float64(p.vx), float64(p.vy), float64(p.omega) * 180 / math.Pi, p.visible != 0}
			if math.IsNaN(v.X) || math.IsInf(v.X, 0) || math.IsNaN(v.Y) || math.IsInf(v.Y, 0) {
				return SceneResult{}, fmt.Errorf("non-finite physical pose at frame %d", f)
			}
			frame.Poses = append(frame.Poses, v)
		}
		result.Frames = append(result.Frames, frame)
	}
	return result, nil
}
