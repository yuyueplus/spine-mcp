package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/internal/trackphysics"
	"io"
	"os"
)

func main() {
	input := flag.String("input", "", "bounded scene JSON")
	output := flag.String("output", "", "NEW result JSON")
	probe := flag.Bool("probe", false, "report solver identity")
	flag.Parse()
	fail := func(e error) {
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
	}
	if *probe {
		fmt.Println(`{"engine":"official Box2D","version":"3.1.1","protocol":"spine-physics/1","circles":true,"staticCapsuleRails":true}`)
		return
	}
	if *input == "" || *output == "" {
		fail(fmt.Errorf("input and NEW output required"))
	}
	f, e := os.Open(*input)
	fail(e)
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 2*1024*1024))
	decoder.DisallowUnknownFields()
	var scene trackphysics.Scene
	fail(decoder.Decode(&scene))
	if decoder.Decode(new(any)) != io.EOF {
		fail(fmt.Errorf("one JSON scene required"))
	}
	result, e := trackphysics.BakeScene(scene)
	fail(e)
	out, e := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	fail(e)
	e = json.NewEncoder(out).Encode(result)
	closed := out.Close()
	fail(e)
	fail(closed)
	fmt.Printf("{\"passed\":true,\"frames\":%d,\"bodies\":%d}\n", len(result.Frames), len(result.BodyIDs))
}
