package trackphysics

import (
	"math"
	"testing"
)

func physicsFixture() Scene {
	return Scene{Duration: 4, FPS: 60, StepHz: 120, Substeps: 8, UnitsPerMeter: 100, Gravity: Point{0, -980}, Bodies: []SceneBody{{ID: "ball", Position: Point{0, 150}, Radius: 10, Density: 1, Friction: .4, Restitution: .2, Category: 1, Mask: 65535}}, Rails: []SceneRail{{Points: []Point{{-100, 0}, {100, 0}}, Radius: 1, Friction: .4, Restitution: .2, Category: 1, Mask: 65535}}}
}
func TestSceneGravityContactAndSleep(t *testing.T) {
	s := physicsFixture()
	m, e := BakeScene(s)
	if e != nil {
		t.Fatal(e)
	}
	if len(m.Frames) != 241 || m.Frames[0].Poses[0].Y != 150 {
		t.Fatal("initial pose/time changed")
	}
	p := m.Frames[len(m.Frames)-1].Poses[0]
	if math.Abs(p.Y-11) > .3 || math.Abs(p.VY) > .1 {
		t.Fatalf("floor contact failed %+v", p)
	}
	if m.Frames[12].Poses[0].Y >= 140 {
		t.Fatal("gravity did not advance")
	}
}
func TestSceneSpawnStackAndDeterminism(t *testing.T) {
	s := physicsFixture()
	b := s.Bodies[0]
	b.ID = "second"
	b.Spawn = 1
	s.Bodies = append(s.Bodies, b)
	a, e := BakeScene(s)
	if e != nil {
		t.Fatal(e)
	}
	baked, e := BakeScene(s)
	if e != nil {
		t.Fatal(e)
	}
	if a.Frames[30].Poses[1].Visible || !a.Frames[61].Poses[1].Visible {
		t.Fatal("spawn activation wrong")
	}
	p, q := a.Frames[240].Poses[0], a.Frames[240].Poses[1]
	if math.Abs(math.Hypot(p.X-q.X, p.Y-q.Y)-20) > .4 {
		t.Fatal("circle contacts missing")
	}
	if a.Frames[240].Poses[1] != baked.Frames[240].Poses[1] {
		t.Fatal("non-deterministic bake")
	}
}
func TestSceneRejectsInvalidBudgets(t *testing.T) {
	s := physicsFixture()
	s.Bodies[0].Radius = math.NaN()
	if _, e := BakeScene(s); e == nil {
		t.Fatal("accepted NaN")
	}
	s = physicsFixture()
	s.Rails[0].Points[1] = s.Rails[0].Points[0]
	if _, e := BakeScene(s); e == nil {
		t.Fatal("accepted zero segment")
	}
	s = physicsFixture()
	s.FPS = 73
	if _, e := BakeScene(s); e == nil {
		t.Fatal("accepted incompatible sample step")
	}
}
