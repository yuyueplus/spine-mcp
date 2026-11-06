package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

func main() {
	binaryFlag := flag.String("binary-dir", filepath.Join("build", "bin", "Release"), "compiled worker/native/shader directory")
	cacheFlag := flag.String("cache", ".cache", "pinned dependency checkout directory")
	outputFlag := flag.String("output", "", "new deployment zip file")
	flag.Parse()
	fail := func(err error) {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	binary, e := filepath.Abs(*binaryFlag)
	fail(e)
	cache, e := filepath.Abs(*cacheFlag)
	fail(e)
	out := *outputFlag
	if out == "" {
		out = filepath.Join("output", fmt.Sprintf("spine-bgfx-0.2.0-%s-%s.zip", runtime.GOOS, runtime.GOARCH))
	}
	worker, library := "spine-worker", "libspine-bgfx.so"
	if runtime.GOOS == "windows" {
		worker += ".exe"
		library = "spine-bgfx.dll"
	} else if runtime.GOOS == "darwin" {
		library = "libspine-bgfx.dylib"
	}
	files := map[string]string{worker: filepath.Join(binary, worker), library: filepath.Join(binary, library), "dependencies.json": "dependencies.json", "README.md": "README.md", "examples/session.json": "examples/session.json", "licenses/Go-LICENSE": filepath.Join(runtime.GOROOT(), "LICENSE")}
	for _, tool := range []string{"spine-roomd", "spine-soak"} {
		if runtime.GOOS == "windows" {
			tool += ".exe"
		}
		files[tool] = filepath.Join(binary, tool)
	}
	fail(filepath.WalkDir(filepath.Join(binary, "shaders"), func(file string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(file, ".bin") {
			rel, e := filepath.Rel(binary, file)
			if e != nil {
				return e
			}
			files[filepath.ToSlash(rel)] = file
		}
		return nil
	}))
	data, e := os.ReadFile("dependencies.json")
	fail(e)
	var deps map[string]any
	fail(json.Unmarshal(data, &deps))
	for name := range deps {
		dir := filepath.Join(cache, name)
		_, e := os.Stat(dir)
		fail(e)
		count := 0
		fail(filepath.WalkDir(dir, func(file string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == ".git" {
					return filepath.SkipDir
				}
				return nil
			}
			base := strings.ToLower(d.Name())
			if !(strings.HasPrefix(base, "license") || strings.HasPrefix(base, "copying") || base == "notice" || base == "unlicense" || base == "copyright" || strings.HasPrefix(base, "third_party_")) {
				return nil
			}
			info, e := d.Info()
			if e != nil {
				return e
			}
			if info.Size() > 4*1024*1024 {
				return nil
			}
			rel, e := filepath.Rel(dir, file)
			if e != nil {
				return e
			}
			files["licenses/"+name+"/"+filepath.ToSlash(rel)] = file
			count++
			return nil
		}))
		if count == 0 {
			fail(fmt.Errorf("no license found for dependency %s", name))
		}
	}
	fail(os.MkdirAll(filepath.Dir(out), 0755))
	f, e := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	fail(e)
	z := zip.NewWriter(f)
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	manifest := map[string]any{"version": "0.2.0", "platform": runtime.GOOS, "arch": runtime.GOARCH, "go": runtime.Version(), "files": map[string]string{}, "requires": []string{"target GPU driver", "ffmpeg and ffprobe", "Spine 4.3 exported character assets"}, "notBundled": []string{"FFmpeg", "character assets", "user configurations"}, "licensing": "Upstream licenses/notices are included. Spine, third-party and compiler redistribution terms still apply."}
	pins := manifest["files"].(map[string]string)
	for _, key := range keys {
		if strings.HasPrefix(key, "/") || strings.Contains(key, "../") {
			fail(errors.New("unsafe zip member path"))
		}
		bytes, e := os.ReadFile(files[key])
		fail(e)
		digest := sha256.Sum256(bytes)
		pins[key] = hex.EncodeToString(digest[:])
		info, e := os.Stat(files[key])
		fail(e)
		header, e := zip.FileInfoHeader(info)
		fail(e)
		header.Name = key
		header.Method = zip.Deflate
		if key == worker || strings.HasPrefix(key, "spine-roomd") || strings.HasPrefix(key, "spine-soak") {
			header.SetMode(0755)
		} else {
			header.SetMode(0644)
		}
		entry, e := z.CreateHeader(header)
		fail(e)
		_, e = entry.Write(bytes)
		fail(e)
	}
	encoded, e := json.MarshalIndent(manifest, "", "  ")
	fail(e)
	entry, e := z.Create("manifest.json")
	fail(e)
	_, e = entry.Write(encoded)
	fail(e)
	fail(z.Close())
	fail(f.Close())
	f, e = os.Open(out)
	fail(e)
	h := sha256.New()
	_, e = io.Copy(h, f)
	f.Close()
	fail(e)
	fmt.Printf("Package: %s\nSHA256: %s\nFiles: %d\n", out, hex.EncodeToString(h.Sum(nil)), len(files)+1)
}
