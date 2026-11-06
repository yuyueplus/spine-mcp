package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

type dependency struct {
	Repository string   `json:"repository"`
	Commit     string   `json:"commit"`
	Sparse     []string `json:"sparse"`
}

func run(dir, name string, args ...string) error {
	c := exec.Command(name, args...)
	c.Dir = dir
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}
func output(dir, name string, args ...string) (string, error) {
	c := exec.Command(name, args...)
	c.Dir = dir
	b, e := c.CombinedOutput()
	return strings.TrimSpace(string(b)), e
}
func exists(p string) bool { _, e := os.Stat(p); return e == nil }
func checkout(cache, name string, p dependency) error {
	if !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(p.Commit) {
		return errors.New("dependency must use an exact commit")
	}
	dir := filepath.Join(cache, name)
	if !exists(filepath.Join(dir, ".git")) {
		if e := os.MkdirAll(dir, 0755); e != nil {
			return e
		}
		if e := run(cache, "git", "init", "--quiet", dir); e != nil {
			return e
		}
		if e := run(dir, "git", "remote", "add", "origin", p.Repository); e != nil {
			return e
		}
	}
	remote, e := output(dir, "git", "remote", "get-url", "origin")
	if e != nil || remote != p.Repository {
		return fmt.Errorf("unexpected dependency origin: %s", dir)
	}
	if len(p.Sparse) > 0 {
		if e = run(dir, "git", "config", "remote.origin.promisor", "true"); e != nil {
			return e
		}
		if e = run(dir, "git", "config", "remote.origin.partialclonefilter", "blob:none"); e != nil {
			return e
		}
	}
	status, e := output(dir, "git", "status", "--porcelain")
	if e != nil || status != "" {
		return fmt.Errorf("dependency has local changes: %s", dir)
	}
	head, _ := output(dir, "git", "rev-parse", "--verify", "HEAD")
	if head != p.Commit {
		args := []string{"fetch", "--depth", "1"}
		if len(p.Sparse) > 0 {
			args = append(args, "--filter=blob:none")
		}
		args = append(args, "origin", p.Commit)
		if e = run(dir, "git", args...); e != nil {
			return e
		}
		if len(p.Sparse) > 0 {
			args = append([]string{"sparse-checkout", "set"}, p.Sparse...)
			if e = run(dir, "git", args...); e != nil {
				return e
			}
		}
		if e = run(dir, "git", "-c", "advice.detachedHead=false", "checkout", "--detach", p.Commit); e != nil {
			return e
		}
	}
	head, e = output(dir, "git", "rev-parse", "HEAD")
	if e != nil || head != p.Commit {
		return fmt.Errorf("dependency revision mismatch: %s", name)
	}
	fmt.Printf("%s: %s\n", name, p.Commit)
	return nil
}
func main() {
	rootFlag := flag.String("root", ".", "native-renderer source directory")
	cacheFlag := flag.String("cache", "", "dependency cache directory")
	buildFlag := flag.String("build", "", "CMake build directory")
	config := flag.String("config", "Release", "Release, Debug or RelWithDebInfo")
	jobs := flag.Int("jobs", 8, "parallel compiler jobs")
	flag.Parse()
	fail := func(e error) {
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
	}
	root, e := filepath.Abs(*rootFlag)
	fail(e)
	cgoEnabled, e := output(root, "go", "env", "CGO_ENABLED")
	fail(e)
	if cgoEnabled != "1" {
		fail(errors.New("build requires CGO_ENABLED=1; use build.ps1 or build.sh"))
	}
	cache := *cacheFlag
	if cache == "" {
		cache = filepath.Join(root, ".cache")
	}
	cache, e = filepath.Abs(cache)
	fail(e)
	build := *buildFlag
	if build == "" {
		build = filepath.Join(root, "build")
	}
	build, e = filepath.Abs(build)
	fail(e)
	if *config != "Release" && *config != "Debug" && *config != "RelWithDebInfo" {
		fail(errors.New("invalid configuration"))
	}
	if *jobs < 1 || *jobs > 64 {
		fail(errors.New("jobs must be within 1..64"))
	}
	data, e := os.ReadFile(filepath.Join(root, "dependencies.json"))
	fail(e)
	var pins map[string]dependency
	fail(json.Unmarshal(data, &pins))
	fail(os.MkdirAll(cache, 0755))
	var wg sync.WaitGroup
	problems := make(chan error, len(pins))
	for name, pin := range pins {
		wg.Add(1)
		go func(name string, pin dependency) {
			defer wg.Done()
			if e := checkout(cache, name, pin); e != nil {
				problems <- e
			}
		}(name, pin)
	}
	wg.Wait()
	close(problems)
	for problem := range problems {
		fail(problem)
	}
	args := []string{"-S", root, "-B", build, "-DLIVE_DEPS_DIR=" + filepath.ToSlash(cache), "-DCMAKE_BUILD_TYPE=" + *config}
	if runtime.GOOS == "windows" {
		args = append(args, "-G", "Visual Studio 17 2022", "-A", "x64")
	}
	fail(run(root, "cmake", args...))
	fail(run(root, "cmake", "--build", build, "--config", *config, "--target", "spine-bgfx", "--parallel", fmt.Sprint(*jobs)))
	name := "spine-worker"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	fail(run(root, "go", "build", "-trimpath", "-o", filepath.Join(build, "bin", *config, name), "./cmd/spine-worker"))
	for _, tool := range []string{"spine-roomd", "spine-soak"} {
		name := tool
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		fail(run(root, "go", "build", "-trimpath", "-o", filepath.Join(build, "bin", *config, name), "./cmd/"+tool))
	}
	fmt.Printf("Built Go/cgo worker and native renderer: %s\n", filepath.Join(build, "bin", *config))
}
