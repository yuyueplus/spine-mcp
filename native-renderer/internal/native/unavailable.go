//go:build !cgo

package native

import "errors"

type Engine struct{}

var errUnavailable = errors.New("bgfx worker requires CGO_ENABLED=1 and a native C compiler")

func Open(string, string, any) (*Engine, error)         { return nil, errUnavailable }
func (*Engine) Info() (Info, error)                     { return Info{}, errUnavailable }
func (*Engine) Step(uint32, bool) (Frame, error)        { return Frame{}, errUnavailable }
func (*Engine) Command(Command) (map[string]any, error) { return nil, errUnavailable }
func (*Engine) Close() error                            { return nil }
