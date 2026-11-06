package broadcast

import (
	"math"
	"math/rand"
)

type spherePosition struct{ x, h, z float64 }

// Bake a repeatable resting pose with gravity, sphere contacts and a curved
// bowl. Only the resulting poses are used at runtime; this is not a full
// real-time rigid-body simulation of the mixing mechanism.
func packSpheres(count int) []spherePosition {
	const radius, bowl, dt = 6.3, 132.0, 1.0 / 100
	rng := rand.New(rand.NewSource(20261106 + int64(count)))
	p := make([]spherePosition, count)
	v := make([]spherePosition, count)
	for i := range p {
		a := float64(i)*2.3999632297 + rng.Float64()*.15
		r := math.Sqrt(rng.Float64()) * 29
		p[i] = spherePosition{math.Cos(a) * r, 70 + float64(i)*3, math.Sin(a) * r}
	}
	for step := 0; step < 1800; step++ {
		old := append([]spherePosition(nil), p...)
		for i := range p {
			v[i].h -= 220 * dt
			v[i].x *= .985
			v[i].z *= .985
			p[i].x += v[i].x * dt
			p[i].h += v[i].h * dt
			p[i].z += v[i].z * dt
		}
		for iteration := 0; iteration < 10; iteration++ {
			for i := range p {
				for j := i + 1; j < count; j++ {
					dx, dh, dz := p[j].x-p[i].x, p[j].h-p[i].h, p[j].z-p[i].z
					distance := math.Sqrt(dx*dx + dh*dh + dz*dz)
					if distance < 2*radius && distance > .000001 {
						correction := (2*radius - distance) / (2 * distance)
						p[i].x -= dx * correction
						p[i].h -= dh * correction
						p[i].z -= dz * correction
						p[j].x += dx * correction
						p[j].h += dh * correction
						p[j].z += dz * correction
					}
				}
			}
			for i := range p {
				dh := p[i].h - bowl
				distance := math.Sqrt(p[i].x*p[i].x + dh*dh + p[i].z*p[i].z)
				if p[i].h < bowl && distance > bowl-radius {
					factor := (bowl - radius) / distance
					p[i].x *= factor
					p[i].h = bowl + dh*factor
					p[i].z *= factor
				}
			}
		}
		for i := range p {
			v[i] = spherePosition{(p[i].x - old[i].x) / dt * .90, (p[i].h - old[i].h) / dt * .90, (p[i].z - old[i].z) / dt * .90}
		}
	}
	return p
}

var initialPacking = packSpheres(49)
var finalPacking = packSpheres(42)

func projectPile(p spherePosition) point {
	return point{618 + p.x*1.14, 496 - p.h*.94 + p.z*.342, clamp(p.z/42, -1, 1)}
}

func restingPosition(i int, afterDraw bool) point {
	if afterDraw && i >= 7 {
		return projectPile(finalPacking[i-7])
	}
	return projectPile(initialPacking[i])
}

func mainScale(i int, t float64) float64 {
	p := mainPosition(i, t)
	scale := .69 * (1 + .045*p.depth)
	if i < 7 && t >= mouthTime(i) && t < releaseTime(i) {
		scale = .64
		if t >= elbowTime(i) {
			scale = mix(.64, 20.4/19, (t-elbowTime(i))/.12)
		}
	}
	if i < 7 && t >= releaseTime(i) {
		scale = 20.4 / 19
	}
	return scale
}

func mainShade(i int, t float64) float64 {
	p := mainPosition(i, t)
	stir := smooth((t-24)/1.3) * (1 - smooth((t-65)/4))
	shade := mix(.47, .75, stir) + .055*p.depth
	if i < 7 && t >= releaseTime(i) {
		shade = mix(shade, .85, dropProgress(i, t))
	}
	return shade
}

func ballAngle(i int) float64 {
	if i < 7 {
		return []float64{-90, -45, -85, 180, -140, 180, 80}[i]
	}
	return math.Mod(float64(i)*137.50776, 360)
}

func settledFrame(i int) int {
	if i < 7 {
		return []int{0, 1, 1, 1, 1, 0, 2}[i]
	}
	return (i*7 + 3) % 24
}
