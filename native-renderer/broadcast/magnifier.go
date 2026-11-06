package broadcast

// Each magnifier is a uniform crop of the wide camera. Background, ball
// position, radius, rotation, colour and visibility share the same state.
type magnifier struct{ SourceX, SourceY, X, Y, Width, Height, Scale float64 }

func magnifierFor(i int) magnifier {
	if i == 6 {
		return magnifier{770 - 70/4.75, 414 - 105/4.75, 230, 560, 140, 160, 4.75}
	}
	return magnifier{450, 312.5, 0, 250, 370, 470, 4.05}
}
func (m magnifier) project(p point) point {
	return point{m.X + (p.x-m.SourceX)*m.Scale, m.Y + (p.y-m.SourceY)*m.Scale, p.depth}
}
func (m magnifier) inverse(p point) point {
	return point{m.SourceX + (p.x-m.X)/m.Scale, m.SourceY + (p.y-m.Y)/m.Scale, p.depth}
}
func (m magnifier) description() map[string]any {
	return map[string]any{"source": []float64{m.SourceX, m.SourceY, m.Width / m.Scale, m.Height / m.Scale}, "destination": []float64{m.X, m.Y, m.Width, m.Height}, "uniformScale": m.Scale, "stateSource": "serialized wide-view keys"}
}
func (m magnifier) plate() map[string]any {
	xy := []point{{m.X, m.Y, 0}, {m.X + m.Width, m.Y, 0}, {m.X + m.Width, m.Y + m.Height, 0}, {m.X, m.Y + m.Height, 0}}
	vertices, uvs := []float64{}, []float64{}
	for _, p := range xy {
		s := m.inverse(p)
		vertices = append(vertices, p.x-640, 360-p.y)
		uvs = append(uvs, s.x/1280, s.y/720)
	}
	return map[string]any{"type": "mesh", "path": "background", "uvs": uvs, "vertices": vertices, "triangles": []int{0, 1, 2, 2, 3, 0}, "hull": 4}
}
func (m magnifier) clip(end string) map[string]any {
	return map[string]any{"type": "clipping", "end": end, "vertexCount": 4, "vertices": []float64{m.X - 640, 360 - m.Y, m.X + m.Width - 640, 360 - m.Y, m.X + m.Width - 640, 360 - m.Y - m.Height, m.X - 640, 360 - m.Y - m.Height}}
}
func magnifiedTracks(master map[string]any, m magnifier) map[string]any {
	translated, scaled := []any{}, []any{}
	for _, entry := range master["translate"].([]any) {
		k := entry.(map[string]any)
		p := m.project(point{k["x"].(float64) + 640, 360 - k["y"].(float64), 0})
		// Transform serialized master keys without a second rounding pass. The
		// equal key times make interpolation commute with this view transform.
		translated = append(translated, map[string]any{"time": k["time"], "x": p.x - 640, "y": 360 - p.y})
	}
	for _, entry := range master["scale"].([]any) {
		k := entry.(map[string]any)
		scaled = append(scaled, map[string]any{"time": k["time"], "x": k["x"].(float64) * m.Scale, "y": k["y"].(float64) * m.Scale})
	}
	return map[string]any{"translate": translated, "scale": scaled, "rotate": master["rotate"]}
}
