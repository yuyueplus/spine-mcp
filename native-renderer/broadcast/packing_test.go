package broadcast

import (
	"math"
	"testing"
)

func TestRestingPileFootprintAndPhysicalContacts(t *testing.T) {
	for _, spheres := range [][]spherePosition{initialPacking, finalPacking} {
		minX, maxX, minY, maxY, nearest := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1), math.Inf(1)
		for i, p := range spheres {
			q := projectPile(p)
			minX, maxX = math.Min(minX, q.x), math.Max(maxX, q.x)
			minY, maxY = math.Min(minY, q.y), math.Max(maxY, q.y)
			for j := i + 1; j < len(spheres); j++ {
				r := spheres[j]
				nearest = math.Min(nearest, math.Sqrt(math.Pow(p.x-r.x, 2)+math.Pow(p.h-r.h, 2)+math.Pow(p.z-r.z, 2)))
			}
		}
		width, height := maxX-minX+12, maxY-minY+12
		t.Logf("%d spheres: footprint %.1fx%.1f at %.1f..%.1f, nearest %.3f", len(spheres), width, height, minY, maxY, nearest)
		if width < 80 || width > 114 || height < 30 || height > 50 || nearest < 12.0 {
			t.Fatal("resting pose is not the compact reference mound or has penetrating spheres")
		}
	}
}
