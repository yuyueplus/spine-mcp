package native

import "encoding/json"

// Frame.Pixels is C-owned and must be consumed before the next native call.
// Copy it first if another goroutine needs to retain a frame.
type Frame struct {
	Pixels                       []byte
	Vertices, Triangles, Batches uint32
	PrepareMS, ReadbackMS        float64
}

type Info struct {
	Renderer              string `json:"renderer"`
	VendorID              uint16 `json:"vendorId"`
	DeviceID              uint16 `json:"deviceId"`
	Width                 int    `json:"width"`
	Height                int    `json:"height"`
	PixelFormat           string `json:"pixelFormat"`
	RowStride             int    `json:"rowStride"`
	ReadbackBytesPerFrame int    `json:"readbackBytesPerFrame"`
	ColorSpace            string `json:"colorSpace"`
	SpineVersion          string `json:"spineVersion"`
	Bones                 int    `json:"bones"`
	Slots                 int    `json:"slots"`
	AtlasPages            int    `json:"atlasPages"`
	AtlasTextureBytes     uint64 `json:"atlasTextureBytes"`
	Animations            []struct {
		Name     string  `json:"name"`
		Duration float64 `json:"duration"`
	} `json:"animations"`
	Skins        []string `json:"skins"`
	Offscreen    bool     `json:"offscreen"`
	NativeWindow bool     `json:"nativeWindow"`
}

type Command struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params map[string]any  `json:"params,omitempty"`
}
